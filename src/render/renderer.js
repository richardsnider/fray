// Canvas 2D renderer that writes units straight into an ImageData buffer.
// Skipping per-dot draw calls (fillRect) is what lets us push many thousands of
// points per frame. Swapping this module for a WebGL point-sprite renderer later
// is a drop-in change — the sim's typed arrays are already GPU-shaped.

import * as U from '../sim/units.js';
import { TEAM_COLORS } from '../config.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.width = 0;
    this.height = 0;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
    this.img = this.ctx.createImageData(w, h);
    this.buildBackground();
  }

  // Terrain is generated once into a static buffer and copied as the base layer
  // each frame — never recomputed. Low-frequency value-noise fbm gives a
  // mottled green/brown field.
  buildBackground() {
    const { width: w, height: h } = this;
    const bg = new Uint8ClampedArray(w * h * 4);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const n = fbm(px * 0.012, py * 0.012);      // 0..1 base
        const m = fbm(px * 0.05 + 100, py * 0.05);  // finer mottle
        const t = n * 0.75 + m * 0.25;
        // Blend between a brown (dry) and green (grass) palette.
        const r = lerp(74, 96, t);
        const g = lerp(78, 128, t);
        const b = lerp(48, 58, t);
        const i = (py * w + px) * 4;
        bg[i] = r; bg[i + 1] = g; bg[i + 2] = b; bg[i + 3] = 255;
      }
    }
    this.bg = bg;
  }

  render(alpha) {
    const data = this.img.data;
    data.set(this.bg); // reset to terrain

    const w = this.width;
    const h = this.height;
    const count = U.count;
    const ROUTING = U.STATE.ROUTING;
    for (let i = 0; i < count; i++) {
      // Interpolate between previous and current sim positions for smoothness.
      const ix = (U.px[i] + (U.x[i] - U.px[i]) * alpha) | 0;
      const iy = (U.py[i] + (U.y[i] - U.py[i]) * alpha) | 0;
      const c = TEAM_COLORS[U.team[i]];
      let r = c[0], g = c[1], b = c[2];
      if (U.state[i] === ROUTING) {
        // Broken units read as dim, desaturated dots so routs are visible.
        r = (r * 0.45) | 0;
        g = (g * 0.45) | 0;
        b = (b * 0.45) | 0;
      }
      // 2x2 block so single soldiers are visible at a glance.
      for (let oy = 0; oy < 2; oy++) {
        const yy = iy + oy;
        if (yy < 0 || yy >= h) continue;
        for (let ox = 0; ox < 2; ox++) {
          const xx = ix + ox;
          if (xx < 0 || xx >= w) continue;
          const idx = (yy * w + xx) * 4;
          data[idx] = r; data[idx + 1] = g; data[idx + 2] = b;
        }
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
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
