// Canvas 2D renderer. Terrain is baked once into an offscreen world-sized canvas
// and blitted per-frame with a source-rect that follows the camera (the browser
// does the zoom scaling, GPU-accelerated). Units are pre-baked sprite stamps
// (pikes squares, archers a square under a bow arc, knights an overhead horse),
// transformed to screen space, culled, and drawn with one drawImage each.
//
// The split is: the bake may be expensive (fine noise octaves, ordered
// dithering), the per-frame path must stay cheap (one terrain blit, binned
// sprite stamps, one vignette blit). Blood decals are stamped into the baked
// canvas as units die, so the battlefield accumulates scars at zero per-frame
// cost, and unit sprites re-bake only when zoom changes (wheel, not per frame).
//
// A renderer is plain data ({ canvas, ctx, width, height, styles, terrain }); the
// functions below take it as their first arg. Swapping this for a WebGL
// point-sprite renderer later is still a drop-in change — the sim's typed arrays
// are GPU-shaped and the camera math is unchanged.

import * as U from '../sim/units.js';
import * as T from '../sim/terrain.js';
import * as world from '../sim/world.js';
import { FLIGHT_TICKS } from '../sim/archery.js';
import { viewWorldW, viewWorldH } from './camera.js';
import { flagMetrics } from './flag.js';
import { lerp, clamp, clamp01, smoothstep, mag } from '../util/math.js';
import {
  MAX_UNITS, TEAM_COLORS, UNIT_TYPE_COUNT, UnitType, WORLD_W, WORLD_H, WATER_LEVEL, AIM_CELL,
} from '../config.js';

const TERRAIN_SCALE = 2;   // bake texels per world unit; 2 → crisp at max zoom. One-time cost (~1.5s).
const TERRAIN_LIFT = 2; // global brightness on the baked palette; 1 = the moody baseline
const HILLSHADE = 7;       // strength of slope shading
const LX = -0.7, LY = -0.7; // light direction (from top-left)

// Procedural ground/forest detail baked into the terrain (renderer-only, seeded).
// Free at runtime — it's part of the one-time bake, not the per-frame blit.
const GROUND_FREQ = 0.06;   // world-space frequency of grass/dirt mottling
const GROUND_MOTTLE = 0.12; // ± brightness from coarse mottling
const DETAIL_FREQ = 0.8;    // fine grass/dirt grain (~2.5 texels per feature)
const DETAIL_AMP = 0.14;    // ± brightness from the fine grain
const DIRT_PATCH = 0.16;    // how much mottling shoves the grass↔dirt mix around
const CANOPY_FREQ = 0.05;   // forest clump size
const SHALLOW = 0.28;       // depth band treated as lit shallows near shore
const STONE_LO = 0.72, STONE_HI = 0.94; // height band where ground breaks into bare rock

// Ordered dithering: quantize each channel to QUANT-wide steps, offset by a 4x4
// Bayer threshold per texel. Smooth noise gradients become deliberate
// limited-palette grain — the difference between "blurry" and "pixel art" once
// nearest-neighbor zoom magnifies the texels.
const QUANT = 9;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const ROUTING = U.STATE.ROUTING;

// Per-type look: archers and pikes wear the plain team color — the archer's
// bow arc tells them apart from a bare pike — while knights get a slight
// white-lifted accent.
//                     KNIGHT              ARCHER               PIKE
const TYPE_ACCENT = [[255, 255, 255],   [0, 0, 0],           [0, 0, 0]];
const TYPE_ACCENT_K = [0.16, 0.0, 0.0];    // blend toward accent
const TYPE_BRIGHT = [1.12, 1.0, 1.0];      // brightness multiplier
const TYPE_SCALE = [1.4, 0.9, 1.2];        // base dot size multiplier (the knight's horse spans 1.7×0.85 dots)

const OUTLINE_STYLE = 'rgb(10,8,10)';      // near-black rim baked into sprites so units pop off any ground
const ARROW_STYLE = 'rgb(216,204,170)';    // pale ash shafts read against the dark ground
const SELECT_RING = 'rgba(140,255,180,0.9)';   // ring under each selected unit
const SELECT_BOX_FILL = 'rgba(140,255,180,0.10)';
const SELECT_BOX_LINE = 'rgba(150,255,185,0.75)';
const BLOOD_A = 'rgb(86,18,14)';
const BLOOD_B = 'rgb(58,12,10)';

// Rally-flag overlay: one small pennant on a pole marks each squad's objective,
// with its code name tagged below. Team color fills the pennant; the pole,
// outline, and label rim are the same near-black used on the sprites.
const FLAG_DARK = 'rgb(10,8,10)';
const FLAG_LABEL = 'rgb(232,230,236)';
const teamRgb = (team) => `rgb(${TEAM_COLORS[team][0]},${TEAM_COLORS[team][1]},${TEAM_COLORS[team][2]})`;

const clamp255 = (v) => clamp(v, 0, 255) | 0;

const KNIGHT = UnitType.KNIGHT;
const FACING_COUNT = 4; // right, left, down, up — knights turn; other types use 0

// One draw bucket per (team, type, routing, facing) combination; each bucket
// draws one pre-baked sprite. Non-knight facings alias facing 0.
const BIN_COUNT = TEAM_COLORS.length * UNIT_TYPE_COUNT * 2 * FACING_COUNT;
const binIndex = (team, type, routing, facing) =>
  ((team * UNIT_TYPE_COUNT + type) * 2 + routing) * FACING_COUNT + facing;

// Per-bucket screen positions, refilled each frame as interleaved (x, y) pairs.
// Int16 holds any screen coordinate and truncates like the old `sx | 0`.
const createBins = () =>
  Array.from({ length: BIN_COUNT }, () => new Int16Array(MAX_UNITS * 2));

// Fill styles: [team][type][active|routing]. Routing dots dim to 45% so broken
// units read at a glance.
const buildStyles = () => TEAM_COLORS.map((c) =>
  Array.from({ length: UNIT_TYPE_COUNT }, (_, t) => {
    const acc = TYPE_ACCENT[t], k = TYPE_ACCENT_K[t], b = TYPE_BRIGHT[t];
    const r = clamp255(lerp(c[0] * b, acc[0], k));
    const g = clamp255(lerp(c[1] * b, acc[1], k));
    const bl = clamp255(lerp(c[2] * b, acc[2], k));
    return [
      `rgb(${r},${g},${bl})`,
      `rgb(${(r * 0.45) | 0},${(g * 0.45) | 0},${(bl * 0.45) | 0})`,
    ];
  })
);

// --- unit sprites ------------------------------------------------------------
// Every unit is a sprite stamp baked per (team, type, routing, facing) at the
// current zoom, outline included, so the per-frame cost is one drawImage per
// unit. Knights get an overhead-horse silhouette with four facings picked from
// velocity; archers a square with a bow arc above; pikes the plain square.

// Overhead horse: the mount seen from directly above (legs tucked under the
// body, out of sight). A rounded-rect body carries a small head blob poking
// past the front and a thin tail trailing the back. Baked facing right (head
// toward +x); the other facings mirror/transpose the mask so every stamp stays
// pixel-crisp. Extents in dots: HORSE_L along the facing axis, HORSE_Wd across.
const HORSE_L = 1.7, HORSE_Wd = 0.85;

// Rasterize the right-facing silhouette into a W×H byte mask (1 = filled).
const horseMask = (s) => {
  const W = Math.max(4, Math.round(HORSE_L * s));
  const H = Math.max(3, Math.round(HORSE_Wd * s));
  const m = new Uint8Array(W * H);
  // Fill an axis-aligned rounded rect [x0,x1)×[y0,y1) with corner radius r.
  const roundRect = (x0, y0, x1, y1, r) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x < x0 + r ? x0 + r - x : x >= x1 - r ? x - (x1 - 1 - r) : 0;
        const dy = y < y0 + r ? y0 + r - y : y >= y1 - r ? y - (y1 - 1 - r) : 0;
        if (dx * dx + dy * dy <= r * r) m[y * W + x] = 1;
      }
    }
  };
  const bx0 = Math.round(0.16 * W), bx1 = Math.round(0.74 * W);
  roundRect(bx0, 0, bx1, H, Math.round(0.4 * H));                                     // body
  const hy0 = Math.round(0.26 * H), hy1 = Math.round(0.74 * H);
  roundRect(bx1 - Math.round(0.04 * W), hy0, W, hy1, Math.round(0.45 * (hy1 - hy0))); // head
  const ty0 = Math.round(0.43 * H), ty1 = Math.max(ty0 + 1, Math.round(0.57 * H));
  for (let y = ty0; y < ty1; y++) for (let x = 0; x < bx0; x++) m[y * W + x] = 1;     // tail
  return { W, H, m };
};

// Reorient the right-facing mask for facing f (0 right, 1 left, 2 down, 3 up).
// Mirror (left) and 90° transpose (down/up) are exact pixel ops — no blur.
const orientMask = ({ W, H, m }, f) => {
  if (f === 0) return { W, H, m };
  if (f === 1) {
    const o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o[y * W + x] = m[y * W + (W - 1 - x)];
    return { W, H, m: o };
  }
  const oW = H, oH = W, o = new Uint8Array(oW * oH);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const nx = f === 2 ? H - 1 - y : y;   // down: head → +y (screen bottom); up: head → -y
    const ny = f === 2 ? x : W - 1 - x;
    o[ny * oW + nx] = m[y * W + x];
  }
  return { W: oW, H: oH, m: o };
};

// Upper-half ring (the archer's bow): fill pixels whose distance from (cx,cy)
// lies in [rIn,rOut], top half only (y ≤ cy) — a crisp pixel-tested arc, no
// path antialiasing.
const fillArc = (g, cx, cy, rIn, rOut) => {
  const ri2 = rIn > 0 ? rIn * rIn : 0, ro2 = rOut * rOut;
  for (let y = -rOut; y <= 0; y++)
    for (let x = -rOut; x <= rOut; x++) {
      const d = x * x + y * y;
      if (d >= ri2 && d <= ro2) g.fillRect(cx + x, cy + y, 1, 1);
    }
};

const bakeSprite = (style, type, s, o, facing) => {
  const c = document.createElement('canvas');
  if (type === KNIGHT) {
    const { W, H, m } = orientMask(horseMask(s), facing);
    c.width = W + 2 * o;
    c.height = H + 2 * o;
    const g = c.getContext('2d');
    // Dilate-then-fill: stamp each filled pixel as an o-inflated block in the
    // rim color first, then the 1px fill on top, leaving an o-thick outline.
    if (o) {
      g.fillStyle = OUTLINE_STYLE;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
        if (m[y * W + x]) g.fillRect(x, y, 1 + 2 * o, 1 + 2 * o);
    }
    g.fillStyle = style;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
      if (m[y * W + x]) g.fillRect(x + o, y + o, 1, 1);
  } else if (type === UnitType.ARCHER) {
    // A pike's square with a bow arc floating just above it. The square keeps
    // the shared footprint (anchored on the unit); the bow only adds headroom.
    const box = s + 2 * o;
    const R = Math.max(2, Math.round(s * 0.55));   // bow radius
    const t = Math.max(1, Math.round(s * 0.18));   // stave thickness
    const gap = Math.max(1, o);                    // clearance above the square
    const cy = R + o, sqTop = cy + gap;
    c.height = sqTop + box;
    c.width = Math.max(box, 2 * (R + o) + 1);
    const g = c.getContext('2d');
    const cx = c.width >> 1, sqLeft = (c.width - box) >> 1;
    if (o) g.fillStyle = OUTLINE_STYLE, fillArc(g, cx, cy, R - t - o, R + o), g.fillRect(sqLeft, sqTop, box, box);
    g.fillStyle = style;
    fillArc(g, cx, cy, R - t, R);
    g.fillRect(sqLeft + o, sqTop + o, s, s);
    // Anchor on the square center so the bow reads as floating above the unit.
    return { c, ax: cx, ay: sqTop + (box >> 1) };
  } else {
    c.width = c.height = s + 2 * o;
    const g = c.getContext('2d');
    o && (g.fillStyle = OUTLINE_STYLE, g.fillRect(0, 0, s + 2 * o, s + 2 * o));
    g.fillStyle = style;
    g.fillRect(o, o, s, s);
  }
  // Anchor at the sprite center so stamps stay put as zoom re-bakes them.
  return { c, ax: c.width >> 1, ay: c.height >> 1 };
};

// (Re)bake the whole sprite set for a zoom level — a few dozen tiny canvases,
// triggered from render() only when the zoom actually changed.
const buildSprites = (r, zoom) => {
  r.spriteZoom = zoom;
  for (let team = 0; team < TEAM_COLORS.length; team++) {
    for (let type = 0; type < UNIT_TYPE_COUNT; type++) {
      const s = Math.max(1, Math.round(1.5 * TYPE_SCALE[type] * zoom));
      const o = s >= 3 ? Math.max(1, s >> 2) : 0; // rim, skipped when dots are tiny
      const facings = type === KNIGHT ? FACING_COUNT : 1;
      for (let routing = 0; routing < 2; routing++) {
        const style = r.styles[team][type][routing];
        for (let f = 0; f < FACING_COUNT; f++) {
          r.sprites[binIndex(team, type, routing, f)] = f < facings
            ? bakeSprite(style, type, s, o, f)
            : r.sprites[binIndex(team, type, routing, 0)];
        }
      }
    }
  }
};

export const create = (canvas) => {
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false; // crisp pixel scaling
  const r = {
    canvas, ctx, width: 0, height: 0, styles: buildStyles(),
    terrain: null, tctx: null, vignette: null,
    bins: createBins(), binN: new Int32Array(BIN_COUNT),
    sprites: new Array(BIN_COUNT), spriteZoom: 0,
    selMark: new Int16Array(MAX_UNITS * 2), // screen (x,y) of visible selected units
  };
  buildTerrain(r);
  resize(r);
  return r;
};

export const resize = (r) => {
  // Render at native device resolution: the backing store is DPR-scaled and the
  // canvas is pinned back to CSS size via style. Without this, every frame on a
  // hi-dpi display is upscaled by the browser and reads blurry no matter how
  // sharp the bake is. Screen space (and camera zoom) is device px throughout.
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  r.canvas.width = w;
  r.canvas.height = h;
  r.canvas.style.width = `${window.innerWidth}px`;
  r.canvas.style.height = `${window.innerHeight}px`;
  r.width = w;
  r.height = h;
  r.ctx.imageSmoothingEnabled = false;
  buildVignette(r);
};

// Radial vignette baked per resize and drawn as a single blit: pulls the frame
// edges toward cold blue-black for mood without touching the per-frame budget.
const buildVignette = (r) => {
  const off = document.createElement('canvas');
  off.width = r.width;
  off.height = r.height;
  const g = off.getContext('2d');
  const cx = r.width / 2, cy = r.height / 2;
  const rad = mag(cx, cy);
  const grad = g.createRadialGradient(cx, cy, rad * 0.45, cx, cy, rad * 1.02);
  grad.addColorStop(0, 'rgba(8,7,14,0)');
  grad.addColorStop(1, 'rgba(8,7,14,0.45)');
  g.fillStyle = grad;
  g.fillRect(0, 0, r.width, r.height);
  r.vignette = off;
};

// Quantize a channel already offset by the Bayer threshold.
const qd = (v) => clamp255(Math.round(v / QUANT) * QUANT);

// Bake the terrain once into an offscreen canvas at TERRAIN_SCALE resolution,
// sampling the shared terrain grids so sim and visuals never disagree.
export const buildTerrain = (r) => {
  const tw = Math.ceil(WORLD_W * TERRAIN_SCALE);
  const th = Math.ceil(WORLD_H * TERRAIN_SCALE);
  const off = document.createElement('canvas');
  off.width = tw;
  off.height = th;
  const octx = off.getContext('2d');
  const img = octx.createImageData(tw, th);
  const data = img.data;
  const d = 8; // finite-difference step (world units) for hillshade
  for (let py = 0; py < th; py++) {
    for (let px = 0; px < tw; px++) {
      const wx = px / TERRAIN_SCALE;
      const wy = py / TERRAIN_SCALE;
      const e = T.elevBilinear(wx, wy);
      let r0, g0, b0;

      if (e < WATER_LEVEL) {
        // Water: dark ink deepening from a mossy lit band at the shore, so
        // coastlines still read while the body stays moody.
        const depth = (WATER_LEVEL - e) / WATER_LEVEL; // 0..1
        const shallow = clamp01(1 - depth / SHALLOW);  // 1 at shore → 0 deep
        r0 = lerp(lerp(30, 8, depth), 58, shallow * 0.5);
        g0 = lerp(lerp(44, 14, depth), 82, shallow * 0.45);
        b0 = lerp(lerp(52, 24, depth), 78, shallow * 0.35);
      } else {
        // Two noise scales: coarse mottling drives brightness + dirt patches,
        // fine grain gives per-texel texture the zoom can magnify.
        const mott = T.noiseAt(wx * GROUND_FREQ, wy * GROUND_FREQ);          // 0..1
        const det = T.noiseAt(wx * DETAIL_FREQ + 37, wy * DETAIL_FREQ + 91); // 0..1

        // Ground tinted by height, nudged by mottling so grass/dirt vary patchily.
        // Palette is deliberately muted and dark (low = dim olive grass, high =
        // cold dry earth) so the team colors carry the brightness of the scene.
        const t = clamp01((e - WATER_LEVEL) / (1 - WATER_LEVEL) + (mott - 0.5) * DIRT_PATCH);
        r0 = lerp(54, 98, t);
        g0 = lerp(70, 84, t);
        b0 = lerp(40, 60, t);

        // The highest ground breaks into bare gray rock.
        const stone = smoothstep(STONE_LO, STONE_HI, t);
        stone > 0 && (
          r0 = lerp(r0, 99, stone), g0 = lerp(g0, 97, stone), b0 = lerp(b0, 104, stone)
        );

        // Directional hillshade from the local slope, times both noise scales.
        const gx = T.elevBilinear(wx + d, wy) - e;
        const gy = T.elevBilinear(wx, wy + d) - e;
        const shade = clamp(1 + (gx * LX + gy * LY) * HILLSHADE, 0.6, 1.4)
          * (1 + (mott - 0.5) * GROUND_MOTTLE)
          * (1 + (det - 0.5) * DETAIL_AMP);
        r0 *= shade; g0 *= shade; b0 *= shade;

        // Forest overlay: a textured two-tone canopy (shadowed trunks → lit
        // leaves) whose edge is dithered by the canopy noise, so brush reads as
        // a stippled tree-line instead of a soft dark blob.
        const cov = T.coverBilinear(wx, wy);
        if (cov > 0.002) {
          const clump = T.noiseAt(wx * CANOPY_FREQ, wy * CANOPY_FREQ);              // coarse clumps
          const leaf = T.noiseAt(wx * CANOPY_FREQ * 3.7 + 19, wy * CANOPY_FREQ * 3.7 + 7); // fine stipple
          const canopy = clump * 0.6 + leaf * 0.4;
          // Near-black forest green: the darkest thing on the map, unmistakable.
          const fr = lerp(10, 30, canopy);
          const fg = lerp(20, 52, canopy);
          const fb = lerp(12, 28, canopy);
          // Crisp onset + canopy-dithered edge → a stippled tree-line, not a blob.
          const k = clamp01(cov * 1.7 - 0.15 - (1 - canopy) * 0.4) * 0.96;
          r0 = lerp(r0, fr, k);
          g0 = lerp(g0, fg, k);
          b0 = lerp(b0, fb, k);
        }
      }

      const i = (py * tw + px) * 4;
      const dth = (BAYER4[(py & 3) * 4 + (px & 3)] / 16 - 0.5) * QUANT;
      data[i] = qd(r0 * TERRAIN_LIFT + dth);
      data[i + 1] = qd(g0 * TERRAIN_LIFT + dth);
      data[i + 2] = qd(b0 * TERRAIN_LIFT + dth);
      data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  r.terrain = off;
  r.tctx = octx; // kept for stamping blood decals into the bake
};

// Fold pending deaths into the baked terrain as small blood splats, then reset
// the log. The battlefield keeps its scars for free — the per-frame blit is
// unchanged — and a regenerate re-bakes a clean field.
const stampDeaths = (r) => {
  const deaths = world.deaths;
  if (deaths.n === 0) return;
  const ctx = r.tctx;
  const S = TERRAIN_SCALE;
  for (let k = 0; k < deaths.n; k++) {
    const x = deaths.x[k], y = deaths.y[k];
    // Seeded jitter from the death position, so a given battle bleeds the same way.
    const j1 = T.noiseAt(x * 3.1 + 11, y * 3.1 + 5) - 0.5;
    const j2 = T.noiseAt(x * 2.7 + 31, y * 2.7 + 17) - 0.5;
    ctx.fillStyle = BLOOD_A;
    ctx.fillRect((x * S - 1 + j1 * 2) | 0, (y * S - 1 + j2 * 2) | 0, 3, 3);
    ctx.fillStyle = BLOOD_B;
    ctx.fillRect((x * S + j1 * 6) | 0, (y * S + j2 * 6) | 0, 2, 2);
    ctx.fillRect((x * S - j2 * 5) | 0, (y * S - j1 * 4) | 0, 1, 1);
  }
  deaths.n = 0;
};

// In-flight volleys, read straight off the archery ring buffer: each entry is a
// massed volley drawn as one shaft climbing a shallow ballistic arc toward its
// beaten zone. Bounded by live archers (reload > flight), so this stays cheap.
const drawArrows = (r, alpha, cam) => {
  const a = world.getArchery();
  if (!a || a.qHead === a.qTail) return;
  const now = world.getTick() + alpha;
  const ctx = r.ctx;
  const zoom = cam.zoom;
  const w = r.width, h = r.height;
  const sz = Math.max(1, Math.round(zoom * 0.45));
  ctx.fillStyle = ARROW_STYLE;
  for (let q = a.qHead; q !== a.qTail; q = (q + 1) % MAX_UNITS) {
    const t = clamp01(1 - (a.qTick[q] - now) / FLIGHT_TICKS);
    const tx = ((a.qCell[q] % a.cols) + 0.5) * AIM_CELL;
    const ty = ((a.qCell[q] / a.cols | 0) + 0.5) * AIM_CELL;
    const x0 = a.qX0[q], y0 = a.qY0[q];
    const wx = lerp(x0, tx, t);
    // Lift ∝ range, peaking mid-flight; drawn as a screen-space y offset.
    const wy = lerp(y0, ty, t) - mag(tx - x0, ty - y0) * 0.12 * Math.sin(Math.PI * t);
    const sx = (wx - cam.x) * zoom;
    if (sx < 0 || sx >= w) continue;
    const sy = (wy - cam.y) * zoom;
    if (sy < 0 || sy >= h) continue;
    ctx.fillRect(sx | 0, sy | 0, sz, sz);
  }
};

// Rally flags, drawn straight from the sim's rally list — a handful per battle,
// so a per-frame path (no baked sprites) stays cheap. The pole base sits on the
// world-space rally point; the squad's code name is stamped just below it.
const drawRallies = (r, cam) => {
  const rallies = world.getRallies();
  if (!rallies.length) return;
  const ctx = r.ctx;
  const zoom = cam.zoom;
  const w = r.width, h = r.height;
  const { px, poleW, poleH, flagW, flagH, ol } = flagMetrics(zoom);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `${px * 5}px monospace`;
  ctx.lineWidth = ol * 2;
  ctx.lineJoin = 'round';
  for (const ral of rallies) {
    const sx = (ral.x - cam.x) * zoom;
    if (sx < -flagW || sx >= w + flagW) continue;
    const sy = (ral.y - cam.y) * zoom;
    if (sy < -poleH || sy >= h + poleH) continue;
    const bx = sx | 0, by = sy | 0;   // pole base == rally point
    const topY = by - poleH;
    // Pole plus a little base foot so it reads as planted in the ground.
    ctx.fillStyle = FLAG_DARK;
    ctx.fillRect(bx, topY, poleW, poleH);
    ctx.fillRect(bx - poleW, by - poleW, poleW * 3, poleW);
    // Pennant: team-color rect with a dark rim, hung at the top of the pole.
    const fx = bx + poleW;
    ctx.fillRect(fx - ol, topY - ol, flagW + 2 * ol, flagH + 2 * ol);
    ctx.fillStyle = teamRgb(ral.team);
    ctx.fillRect(fx, topY, flagW, flagH);
    // Code-name label, centered under the pole with a dark rim for legibility.
    const ly = by + poleW + ol;
    ctx.strokeStyle = FLAG_DARK;
    ctx.fillStyle = FLAG_LABEL;
    ctx.strokeText(ral.label, bx, ly);
    ctx.fillText(ral.label, bx, ly);
  }
};

export const render = (r, alpha, cam, selBox = null) => {
  const ctx = r.ctx;
  const w = r.width;
  const h = r.height;

  // --- terrain: stamp fresh blood into the bake, blit the camera window -------
  stampDeaths(r);
  const S = TERRAIN_SCALE;
  ctx.drawImage(
    r.terrain,
    cam.x * S, cam.y * S, viewWorldW(cam) * S, viewWorldH(cam) * S,
    0, 0, w, h,
  );

  // --- units: transform to screen, cull, stamp sprites in buckets -------------
  const count = U.count;
  const zoom = cam.zoom;
  const camX = cam.x;
  const camY = cam.y;

  zoom !== r.spriteZoom && buildSprites(r, zoom);

  // One pass bins each visible unit's screen position by (team, type, routing,
  // facing); each bin then stamps its pre-baked sprite. Facing only varies for
  // knights, quantized from velocity to right/left/down/up.
  const { bins, binN, selMark } = r;
  binN.fill(0);
  let selN = 0;
  for (let i = 0; i < count; i++) {
    const wx = U.px[i] + (U.x[i] - U.px[i]) * alpha;
    const sx = (wx - camX) * zoom;
    if (sx < 0 || sx >= w) continue;
    const wy = U.py[i] + (U.y[i] - U.py[i]) * alpha;
    const sy = (wy - camY) * zoom;
    if (sy < 0 || sy >= h) continue;
    if (U.selected[i]) { selMark[selN] = sx; selMark[selN + 1] = sy; selN += 2; }
    const type = U.type[i];
    let f = 0;
    type === KNIGHT && (
      f = Math.abs(U.vx[i]) >= Math.abs(U.vy[i])
        ? (U.vx[i] >= 0 ? 0 : 1)
        : (U.vy[i] >= 0 ? 2 : 3)
    );
    const b = binIndex(U.team[i], type, U.state[i] === ROUTING ? 1 : 0, f);
    const bin = bins[b];
    const n = binN[b];
    bin[n] = sx;
    bin[n + 1] = sy;
    binN[b] = n + 2;
  }

  // Selection rings, batched into one stroked path so they sit under the sprites.
  if (selN) {
    const rad = Math.max(2, zoom * 0.9);
    ctx.beginPath();
    for (let k = 0; k < selN; k += 2) {
      const x = selMark[k], y = selMark[k + 1];
      ctx.moveTo(x + rad, y);
      ctx.arc(x, y, rad, 0, Math.PI * 2);
    }
    ctx.lineWidth = Math.max(1, zoom * 0.18);
    ctx.strokeStyle = SELECT_RING;
    ctx.stroke();
  }

  for (let b = 0; b < BIN_COUNT; b++) {
    const n = binN[b];
    if (n === 0) continue;
    const { c, ax, ay } = r.sprites[b];
    const bin = bins[b];
    for (let k = 0; k < n; k += 2) ctx.drawImage(c, bin[k] - ax, bin[k + 1] - ay);
  }

  // --- overlays: rally flags, volleys in the air, the selection box, vignette --
  drawRallies(r, cam);
  drawArrows(r, alpha, cam);
  if (selBox) {
    const bx = Math.min(selBox.x0, selBox.x1), by = Math.min(selBox.y0, selBox.y1);
    const bw = Math.abs(selBox.x1 - selBox.x0), bh = Math.abs(selBox.y1 - selBox.y0);
    ctx.fillStyle = SELECT_BOX_FILL;
    ctx.fillRect(bx, by, bw, bh);
    ctx.lineWidth = 1;
    ctx.strokeStyle = SELECT_BOX_LINE;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
  }
  ctx.drawImage(r.vignette, 0, 0);
};
