// Canvas 2D renderer. Terrain is baked once into an offscreen world-sized canvas
// and blitted per-frame with a source-rect that follows the camera (the browser
// does the zoom scaling, GPU-accelerated). Units are drawn as small filled rects,
// transformed to screen space and culled to the viewport.
//
// A renderer is plain data ({ canvas, ctx, width, height, styles, terrain }); the
// functions below take it as their first arg. Swapping this for a WebGL
// point-sprite renderer later is still a drop-in change — the sim's typed arrays
// are GPU-shaped and the camera math is unchanged.

import * as U from '../sim/units.js';
import * as T from '../sim/terrain.js';
import { viewWorldW, viewWorldH } from './camera.js';
import { lerp, clamp, clamp01 } from '../util/math.js';
import { TEAM_COLORS, UNIT_TYPE_COUNT, WORLD_W, WORLD_H, WATER_LEVEL } from '../config.js';

const TERRAIN_SCALE = 0.75; // bake resolution; higher = crisper (esp. zoomed). One-time cost.
const HILLSHADE = 7;       // strength of slope shading
const LX = -0.7, LY = -0.7; // light direction (from top-left)

// Procedural ground/forest detail baked into the terrain (renderer-only, seeded).
// Free at runtime — it's part of the one-time bake, not the per-frame blit.
const GROUND_FREQ = 0.06;   // world-space frequency of grass/dirt mottling
const GROUND_MOTTLE = 0.12; // ± brightness from fine mottling
const DIRT_PATCH = 0.16;    // how much mottling shoves the grass↔dirt mix around
const CANOPY_FREQ = 0.05;   // forest clump size
const SHALLOW = 0.28;       // depth band treated as lit shallows near shore
const ROUTING = U.STATE.ROUTING;

// Per-type look, kept subtle so the team hue still dominates. Each type nudges
// the team color toward an accent and scales the dot: knights read as bright,
// larger horse; archers as smaller, drab leather; pikes as the plain team base.
//                     KNIGHT              ARCHER               PIKE
const TYPE_ACCENT = [[255, 255, 255],   [120, 140, 70],      [0, 0, 0]];
const TYPE_ACCENT_K = [0.16, 0.32, 0.0];   // blend toward accent
const TYPE_BRIGHT = [1.12, 0.82, 0.95];    // brightness multiplier
const TYPE_SCALE = [1.8, 0.9, 1.2];        // dot size multiplier

const clamp255 = (v) => clamp(v, 0, 255) | 0;

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
  const r = { canvas, ctx, width: 0, height: 0, styles: buildStyles(), terrain: null };
  buildTerrain(r);
  resize(r);
  return r;
};

export const resize = (r) => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  r.canvas.width = w;
  r.canvas.height = h;
  r.width = w;
  r.height = h;
  r.ctx.imageSmoothingEnabled = false;
};

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
      const i = (py * tw + px) * 4;

      if (e < WATER_LEVEL) {
        // Water: deep→shallow gradient, with a lit shallows band near the shore
        // so coastlines read as beaches rather than a hard edge.
        const depth = (WATER_LEVEL - e) / WATER_LEVEL; // 0..1
        const shallow = clamp01(1 - depth / SHALLOW);  // 1 at shore → 0 deep
        data[i] = lerp(lerp(64, 26, depth), 120, shallow * 0.5);
        data[i + 1] = lerp(lerp(108, 58, depth), 160, shallow * 0.45);
        data[i + 2] = lerp(lerp(150, 120, depth), 165, shallow * 0.3);
        data[i + 3] = 255;
        continue;
      }

      // Fine mottling: one seeded noise sample reused for brightness + dirt patches.
      const mott = T.noiseAt(wx * GROUND_FREQ, wy * GROUND_FREQ); // 0..1

      // Ground tinted by height, nudged by mottling so grass/dirt vary patchily
      // instead of a smooth gradient (low = grass green, high = dry brown).
      const t = clamp01((e - WATER_LEVEL) / (1 - WATER_LEVEL) + (mott - 0.5) * DIRT_PATCH);
      let r0 = lerp(86, 132, t);
      let g0 = lerp(122, 108, t);
      let b0 = lerp(58, 74, t);

      // Directional hillshade from the local slope, times a fine grass mottle.
      const gx = T.elevBilinear(wx + d, wy) - e;
      const gy = T.elevBilinear(wx, wy + d) - e;
      const shade = clamp(1 + (gx * LX + gy * LY) * HILLSHADE, 0.6, 1.4)
        * (1 + (mott - 0.5) * GROUND_MOTTLE);
      r0 *= shade; g0 *= shade; b0 *= shade;

      // Forest overlay: a textured two-tone canopy (shadowed trunks → lit leaves)
      // whose edge is dithered by the canopy noise, so brush reads as a stippled
      // tree-line instead of a soft dark blob.
      const cov = T.coverBilinear(wx, wy);
      if (cov > 0.002) {
        const clump = T.noiseAt(wx * CANOPY_FREQ, wy * CANOPY_FREQ);              // coarse clumps
        const leaf = T.noiseAt(wx * CANOPY_FREQ * 3.7 + 19, wy * CANOPY_FREQ * 3.7 + 7); // fine stipple
        const canopy = clump * 0.6 + leaf * 0.4;
        // Distinctly dark, saturated forest green so it reads clearly against
        // grass; the two tones give leaf texture without lifting the mean toward
        // grass brightness.
        const fr = lerp(20, 50, canopy);
        const fg = lerp(40, 86, canopy);
        const fb = lerp(24, 40, canopy);
        // Crisp onset + canopy-dithered edge → a stippled tree-line, not a blob.
        const k = clamp01(cov * 1.7 - 0.15 - (1 - canopy) * 0.4) * 0.96;
        r0 = lerp(r0, fr, k);
        g0 = lerp(g0, fg, k);
        b0 = lerp(b0, fb, k);
      }

      data[i] = r0; data[i + 1] = g0; data[i + 2] = b0; data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  r.terrain = off;
};

export const render = (r, alpha, cam) => {
  const ctx = r.ctx;
  const w = r.width;
  const h = r.height;

  // --- terrain: blit the camera window from the baked world canvas ------------
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

  // Bucket by team → type → routing so fillStyle and dot size are set once per
  // group rather than per unit.
  for (let team = 0; team < r.styles.length; team++) {
    for (let type = 0; type < UNIT_TYPE_COUNT; type++) {
      const dot = Math.max(1, Math.round(1.5 * TYPE_SCALE[type] * zoom));
      for (let routing = 0; routing < 2; routing++) {
        ctx.fillStyle = r.styles[team][type][routing];
        const wantRouting = routing === 1;
        for (let i = 0; i < count; i++) {
          if (U.team[i] !== team || U.type[i] !== type) continue;
          if ((U.state[i] === ROUTING) !== wantRouting) continue;
          const wx = U.px[i] + (U.x[i] - U.px[i]) * alpha;
          const wy = U.py[i] + (U.y[i] - U.py[i]) * alpha;
          const sx = (wx - camX) * zoom;
          if (sx < 0 || sx >= w) continue;
          const sy = (wy - camY) * zoom;
          if (sy < 0 || sy >= h) continue;
          ctx.fillRect(sx | 0, sy | 0, dot, dot);
        }
      }
    }
  }
};
