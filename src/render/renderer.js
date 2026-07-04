// Canvas 2D renderer. Terrain is baked once into an offscreen world-sized canvas
// and blitted per-frame with a source-rect that follows the camera (the browser
// does the zoom scaling, GPU-accelerated). Units are drawn as small filled rects,
// transformed to screen space and culled to the viewport.
//
// The split is: the bake may be expensive (fine noise octaves, ordered
// dithering), the per-frame path must stay cheap (one terrain blit, binned
// fillRects, one vignette blit). Blood decals are stamped into the baked canvas
// as units die, so the battlefield accumulates scars at zero per-frame cost.
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
import { lerp, clamp, clamp01, smoothstep, mag } from '../util/math.js';
import {
  MAX_UNITS, TEAM_COLORS, UNIT_TYPE_COUNT, WORLD_W, WORLD_H, WATER_LEVEL, AIM_CELL,
} from '../config.js';

const TERRAIN_SCALE = 2;   // bake texels per world unit; 2 → crisp at max zoom. One-time cost (~1.5s).
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

// Per-type look, kept subtle so the team hue still dominates. Each type nudges
// the team color toward an accent and scales the dot: knights read as bright,
// larger horse; archers as smaller, drab leather; pikes as the plain team base.
//                     KNIGHT              ARCHER               PIKE
const TYPE_ACCENT = [[255, 255, 255],   [120, 140, 70],      [0, 0, 0]];
const TYPE_ACCENT_K = [0.16, 0.32, 0.0];   // blend toward accent
const TYPE_BRIGHT = [1.12, 0.82, 0.95];    // brightness multiplier
const TYPE_SCALE = [1.8, 0.9, 1.2];        // dot size multiplier

const OUTLINE_STYLE = 'rgb(10,8,10)';      // near-black rim so dots pop off any ground
const ARROW_STYLE = 'rgb(216,204,170)';    // pale ash shafts read against the dark ground
const BLOOD_A = 'rgb(86,18,14)';
const BLOOD_B = 'rgb(58,12,10)';

const clamp255 = (v) => clamp(v, 0, 255) | 0;

// One draw bucket per (team, type, routing) combination.
const BIN_COUNT = TEAM_COLORS.length * UNIT_TYPE_COUNT * 2;

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

export const create = (canvas) => {
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false; // crisp pixel scaling
  const r = {
    canvas, ctx, width: 0, height: 0, styles: buildStyles(),
    terrain: null, tctx: null, vignette: null,
    bins: createBins(), binN: new Int32Array(BIN_COUNT),
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
      data[i] = qd(r0 + dth);
      data[i + 1] = qd(g0 + dth);
      data[i + 2] = qd(b0 + dth);
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

export const render = (r, alpha, cam) => {
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

  // --- units: transform to screen, cull, draw in color/size buckets -----------
  const count = U.count;
  const zoom = cam.zoom;
  const camX = cam.x;
  const camY = cam.y;

  // One pass bins each visible unit's screen position by (team, type, routing);
  // each bin then draws with fillStyle and dot size set once. Bins are emitted
  // in the same nested order the old 12 filter passes used, so the output is
  // pixel-identical at 1/12th the iteration.
  const { bins, binN } = r;
  binN.fill(0);
  for (let i = 0; i < count; i++) {
    const wx = U.px[i] + (U.x[i] - U.px[i]) * alpha;
    const sx = (wx - camX) * zoom;
    if (sx < 0 || sx >= w) continue;
    const wy = U.py[i] + (U.y[i] - U.py[i]) * alpha;
    const sy = (wy - camY) * zoom;
    if (sy < 0 || sy >= h) continue;
    const b = (U.team[i] * UNIT_TYPE_COUNT + U.type[i]) * 2 + (U.state[i] === ROUTING ? 1 : 0);
    const bin = bins[b];
    const n = binN[b];
    bin[n] = sx;
    bin[n + 1] = sy;
    binN[b] = n + 2;
  }

  for (let team = 0; team < r.styles.length; team++) {
    for (let type = 0; type < UNIT_TYPE_COUNT; type++) {
      const dot = Math.max(1, Math.round(1.5 * TYPE_SCALE[type] * zoom));
      // Dark rim under each dot so units pop off the terrain; skipped while the
      // dots are too small to spare the pixels.
      const o = dot >= 3 ? Math.max(1, dot >> 2) : 0;
      for (let routing = 0; routing < 2; routing++) {
        const b = (team * UNIT_TYPE_COUNT + type) * 2 + routing;
        const n = binN[b];
        if (n === 0) continue;
        const bin = bins[b];
        if (o) {
          ctx.fillStyle = OUTLINE_STYLE;
          const side = dot + 2 * o;
          for (let k = 0; k < n; k += 2) ctx.fillRect(bin[k] - o, bin[k + 1] - o, side, side);
        }
        ctx.fillStyle = r.styles[team][type][routing];
        for (let k = 0; k < n; k += 2) ctx.fillRect(bin[k], bin[k + 1], dot, dot);
      }
    }
  }

  // --- overlays: volleys in the air, then the vignette ------------------------
  drawArrows(r, alpha, cam);
  ctx.drawImage(r.vignette, 0, 0);
};
