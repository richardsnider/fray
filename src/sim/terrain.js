// Terrain data: coarse typed-array grids shared by the sim and the renderer, so
// there is a single source of truth for the battlefield. One cell spans
// TERRAIN_CELL world units. Generated once, deterministically, from value-noise
// fbm. The sim reads it (nearest-cell) for passability/slope/cover; the renderer
// reads it (bilinear) to bake the ground.

import { WORLD_W, WORLD_H, TERRAIN_CELL, WATER_LEVEL } from '../config.js';
import { lerp, clamp01, smoothstep } from '../util/math.js';
import { cellIndexOf, sampleBilinear } from '../util/grid2d.js';

export const CELL = TERRAIN_CELL;

// Live bindings — importers read these after generate().
export let cols = 0;
export let rows = 0;
export let elevation = new Float32Array(0); // 0..1
let water = new Uint8Array(0);               // 1 = impassable (internal; use isWaterAt)
export let cover = new Float32Array(0);      // 0..1 brush density

// Folded into the value-noise hash so each seed yields a distinct battlefield.
let seed = 0;

export const generate = (s = 0) => {
  seed = s >>> 0;
  cols = Math.ceil(WORLD_W / CELL) + 1;
  rows = Math.ceil(WORLD_H / CELL) + 1;
  const n = cols * rows;
  elevation = new Float32Array(n);
  water = new Uint8Array(n);
  cover = new Float32Array(n);

  const NORM = 1 / 0.9375; // fbm() max, to normalize into 0..1
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const wx = cx * CELL;
      const wy = cy * CELL;
      const i = cy * cols + cx;

      // Low-frequency landforms → a few hills and water bodies across the map.
      const e = clamp01(fbm(wx * 0.0016, wy * 0.0016) * NORM);
      elevation[i] = e;
      water[i] = e < WATER_LEVEL ? 1 : 0;

      // Mid-frequency brush patches; never in water.
      const c = fbm(wx * 0.004 + 50, wy * 0.004 + 50) * NORM;
      cover[i] = water[i] ? 0 : smoothstep(0.5, 0.72, c);
    }
  }
};

// --- sampling --------------------------------------------------------------
export const cellOf = (wx, wy) => cellIndexOf(wx, wy, CELL, cols, rows);

export const isWaterAt = (wx, wy) => water[cellOf(wx, wy)] === 1;
export const elevBilinear = (wx, wy) => sampleBilinear(elevation, cols, rows, CELL, wx, wy);
export const coverBilinear = (wx, wy) => sampleBilinear(cover, cols, rows, CELL, wx, wy);

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
