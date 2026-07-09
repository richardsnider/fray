// Terrain data: coarse typed-array grids shared by the sim and the renderer, so
// there is a single source of truth for the battlefield. One cell spans
// TERRAIN_CELL world units. Generated once, deterministically, from value-noise
// fbm. The sim reads it (nearest-cell) for passability/slope/cover; the renderer
// reads it (bilinear) to bake the ground.

import { WORLD_W, WORLD_H, TERRAIN_CELL, WATER_LEVEL, MUD_BAND } from '../config.js';
import { lerp, clamp01, clampIndex, smoothstep } from '../util/math.js';
import { cellIndexOf, sampleBilinear } from '../util/grid2d.js';

export const CELL = TERRAIN_CELL;

// Live bindings — importers read these after generate().
export let cols = 0;
export let rows = 0;
export let elevation = new Float32Array(0); // 0..1
let ground = new Uint8Array(0);              // ground class (internal; use isWaterAt/mudAt)
export let cover = new Float32Array(0);      // 0..1 brush density

// Ground classes. Water is impassable; mud is passable soft ground (a speed
// penalty in the sim, dark wet brown in the bake); everything else is land.
const LAND = 0, WATER = 1, MUD = 2;

// Marsh: beyond the always-wet shoreline band (MUD_BAND), a noise gate pools
// mud in patches over low ground, so bottomlands break into bog instead of
// every shore wearing one uniform wet ring. Generation details, so they live
// here rather than config (like the brush smoothstep bounds below).
const MARSH_BAND = 3 * MUD_BAND;   // how high above the waterline marsh can pool
const MARSH_GATE = 0.67;           // marsh-noise threshold for a bog patch

// Folded into the value-noise hash so each seed yields a distinct battlefield.
let seed = 0;

// `paint` (test-only, used by the balance harness's scenarios): a
// deterministic fn(wx, wy) → { elev = 0.5, cover = 0, water = false,
// mud = false } that replaces the fbm landforms, so a scenario battle
// controls the ground exactly — a flat field, uniform brush, one muddy half.
export const generate = (s = 0, paint = null) => {
  seed = s >>> 0;
  cols = Math.ceil(WORLD_W / CELL) + 1;
  rows = Math.ceil(WORLD_H / CELL) + 1;
  const n = cols * rows;
  elevation = new Float32Array(n);
  ground = new Uint8Array(n);
  cover = new Float32Array(n);

  if (paint) {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        const p = paint(cx * CELL, cy * CELL);
        elevation[i] = p.elev ?? 0.5;
        ground[i] = p.water ? WATER : p.mud ? MUD : LAND;
        cover[i] = p.water ? 0 : p.cover ?? 0;
      }
    }
    return;
  }

  const NORM = 1 / 0.9375; // fbm() max, to normalize into 0..1
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const wx = cx * CELL;
      const wy = cy * CELL;
      const i = cy * cols + cx;

      // Low-frequency landforms → a few hills and water bodies across the map.
      const e = clamp01(fbm(wx * 0.0016, wy * 0.0016) * NORM);
      elevation[i] = e;
      // Class: water below the line; the low band above it is always wet mud,
      // and marsh noise pools bog patches a little higher (same fbm family at
      // its own offset, so it's deterministic per seed like everything else).
      ground[i] = e < WATER_LEVEL ? WATER
        : e < WATER_LEVEL + MUD_BAND ? MUD
        : e < WATER_LEVEL + MARSH_BAND
            && fbm(wx * 0.004 + 100, wy * 0.004 + 100) * NORM > MARSH_GATE ? MUD
        : LAND;

      // Mid-frequency brush patches; never in water (reedy mud is fine).
      const c = fbm(wx * 0.004 + 50, wy * 0.004 + 50) * NORM;
      cover[i] = ground[i] === WATER ? 0 : smoothstep(0.5, 0.72, c);
    }
  }
};

// --- sampling --------------------------------------------------------------
export const cellOf = (wx, wy) => cellIndexOf(wx, wy, CELL, cols, rows);

export const isWaterAt = (wx, wy) => ground[cellOf(wx, wy)] === WATER;
export const mudAt = (wx, wy) => ground[cellOf(wx, wy)] === MUD;
export const elevBilinear = (wx, wy) => sampleBilinear(elevation, cols, rows, CELL, wx, wy);
export const coverBilinear = (wx, wy) => sampleBilinear(cover, cols, rows, CELL, wx, wy);

// Mudness 0..1 at a world point — bilinear over the mud mask, so the ground
// bake feathers mud edges instead of stepping at cell size. Renderer-only;
// the sim reads mud nearest-cell via mudAt like every other terrain effect.
export const mudBilinear = (wx, wy) => {
  const fx = wx / CELL, fy = wy / CELL;
  const fx0 = Math.floor(fx), fy0 = Math.floor(fy);
  const tx = fx - fx0, ty = fy - fy0;
  const x0 = clampIndex(fx0, cols), y0 = clampIndex(fy0, rows);
  const x1 = x0 + 1 < cols ? x0 + 1 : x0;
  const y1 = y0 + 1 < rows ? y0 + 1 : y0;
  const r0 = y0 * cols, r1 = y1 * cols;
  const m = (c) => (ground[c] === MUD ? 1 : 0);
  return lerp(lerp(m(r0 + x0), m(r0 + x1), tx), lerp(m(r1 + x0), m(r1 + x1), tx), ty);
};

// --- compact hash-based value noise + fbm ----------------------------------
const hash = (x, y) => {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519)) | 0;
  n = Math.imul(n ^ (n >> 13), 1274126177);
  n = n ^ (n >> 16);
  return (n & 0xffff) / 0xffff;
};

const valueNoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
};

// Seeded single-octave value noise at a world point (0..1), for renderer-only
// visual detail (ground mottling, forest canopy). Does NOT affect the sim, which
// reads the coarse elevation/water/cover grids — so it's free to be high-frequency.
export const noiseAt = (wx, wy) => valueNoise(wx, wy);

const fbm = (x, y) => {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += valueNoise(x * freq, y * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum; // ~0..0.9375
};
