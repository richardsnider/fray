// Canvas 2D renderer driven by a Camera. Terrain is baked once into an offscreen
// world-sized canvas and blitted per-frame with a source-rect that follows the
// camera (the browser does the zoom scaling, GPU-accelerated). Units are drawn as
// small filled rects, transformed to screen space and culled to the viewport.
//
// Swapping this for a WebGL point-sprite renderer later is still a drop-in change
// — the sim's typed arrays are GPU-shaped and the Camera math is unchanged.

import * as U from '../sim/units.js';
import { TEAM_COLORS, WORLD_W, WORLD_H } from '../config.js';

const TERRAIN_SCALE = 0.5; // bake terrain at half world-res; low-freq, upscales fine
const ROUTING = U.STATE.ROUTING;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false; // crisp pixel scaling
    this.width = 0;
    this.height = 0;

    // Precompute the four fill styles: [team][active|routing].
    this.styles = TEAM_COLORS.map((c) => [
      `rgb(${c[0]},${c[1]},${c[2]})`,
      `rgb(${(c[0] * 0.45) | 0},${(c[1] * 0.45) | 0},${(c[2] * 0.45) | 0})`,
    ]);

    this.buildTerrain();
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
    this.ctx.imageSmoothingEnabled = false;
  }

  // Bake the terrain once into an offscreen canvas at TERRAIN_SCALE resolution.
  buildTerrain() {
    const tw = Math.ceil(WORLD_W * TERRAIN_SCALE);
    const th = Math.ceil(WORLD_H * TERRAIN_SCALE);
    const off = document.createElement('canvas');
    off.width = tw;
    off.height = th;
    const octx = off.getContext('2d');
    const img = octx.createImageData(tw, th);
    const data = img.data;
    for (let py = 0; py < th; py++) {
      for (let px = 0; px < tw; px++) {
        // Sample in world units so the look is resolution-independent.
        const wx = px / TERRAIN_SCALE;
        const wy = py / TERRAIN_SCALE;
        const n = fbm(wx * 0.012, wy * 0.012);
        const m = fbm(wx * 0.05 + 100, wy * 0.05);
        const t = n * 0.75 + m * 0.25;
        const i = (py * tw + px) * 4;
        data[i] = lerp(74, 96, t);
        data[i + 1] = lerp(78, 128, t);
        data[i + 2] = lerp(48, 58, t);
        data[i + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    this.terrain = off;
  }

  render(alpha, cam) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // --- terrain: blit the camera window from the baked world canvas ----------
    const S = TERRAIN_SCALE;
    ctx.drawImage(
      this.terrain,
      cam.x * S, cam.y * S, cam.viewWorldW * S, cam.viewWorldH * S,
      0, 0, w, h,
    );

    // --- units: transform to screen, cull, draw in 4 color buckets ------------
    const count = U.count;
    const zoom = cam.zoom;
    const camX = cam.x;
    const camY = cam.y;
    const dot = Math.max(1, Math.round(1.5 * zoom));

    for (let team = 0; team < this.styles.length; team++) {
      for (let routing = 0; routing < 2; routing++) {
        ctx.fillStyle = this.styles[team][routing];
        const wantRouting = routing === 1;
        for (let i = 0; i < count; i++) {
          if (U.team[i] !== team) continue;
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
}

function lerp(a, b, t) { return a + (b - a) * t; }

// --- compact hash-based value noise + fbm ---------------------------------
function hash(x, y) {
  let n = x * 374761393 + y * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  n = n ^ (n >> 16);
  return (n & 0xffff) / 0xffff;
}

function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm(x, y) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += valueNoise(x * freq, y * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum; // ~0..0.9375
}
