// Canvas 2D renderer driven by a Camera. Terrain is baked once into an offscreen
// world-sized canvas and blitted per-frame with a source-rect that follows the
// camera (the browser does the zoom scaling, GPU-accelerated). Units are drawn as
// small filled rects, transformed to screen space and culled to the viewport.
//
// Swapping this for a WebGL point-sprite renderer later is still a drop-in change
// — the sim's typed arrays are GPU-shaped and the Camera math is unchanged.

import * as U from '../sim/units.js';
import * as T from '../sim/terrain.js';
import { TEAM_COLORS, UNIT_TYPE_COUNT, WORLD_W, WORLD_H, WATER_LEVEL } from '../config.js';

const TERRAIN_SCALE = 0.5; // bake terrain at half world-res; low-freq, upscales fine
const HILLSHADE = 7;       // strength of slope shading
const LX = -0.7, LY = -0.7; // light direction (from top-left)
const ROUTING = U.STATE.ROUTING;

// Per-type look, kept subtle so the team hue still dominates. Each type nudges
// the team color toward an accent and scales the dot: knights read as bright,
// larger horse; archers as smaller, drab leather; pikes as the plain team base.
//                     KNIGHT              ARCHER               PIKE
const TYPE_ACCENT = [[255, 255, 255],   [120, 140, 70],      [0, 0, 0]];
const TYPE_ACCENT_K = [0.16, 0.32, 0.0];   // blend toward accent
const TYPE_BRIGHT = [1.12, 0.82, 0.95];    // brightness multiplier
const TYPE_SCALE = [1.8, 0.9, 1.2];        // dot size multiplier

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false; // crisp pixel scaling
    this.width = 0;
    this.height = 0;

    // Precompute fill styles: [team][type][active|routing]. Routing dots dim to
    // 45% so broken units read at a glance.
    this.styles = TEAM_COLORS.map((c) =>
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

  // Bake the terrain once into an offscreen canvas at TERRAIN_SCALE resolution,
  // sampling the shared terrain grids so sim and visuals never disagree.
  buildTerrain() {
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
          // Water: deeper (lower) reads darker blue.
          const depth = (WATER_LEVEL - e) / WATER_LEVEL; // 0..1
          data[i] = lerp(64, 26, depth);
          data[i + 1] = lerp(108, 58, depth);
          data[i + 2] = lerp(150, 120, depth);
          data[i + 3] = 255;
          continue;
        }

        // Ground tinted by height: low = grass green, high = dry brown.
        const t = (e - WATER_LEVEL) / (1 - WATER_LEVEL);
        let r = lerp(86, 132, t);
        let g = lerp(122, 108, t);
        let b = lerp(58, 74, t);

        // Directional hillshade from the local slope.
        const gx = T.elevBilinear(wx + d, wy) - e;
        const gy = T.elevBilinear(wx, wy + d) - e;
        let shade = 1 + (gx * LX + gy * LY) * HILLSHADE;
        if (shade < 0.6) shade = 0.6; else if (shade > 1.4) shade = 1.4;
        r *= shade; g *= shade; b *= shade;

        // Brush overlay: blend toward a dark, muted green.
        const c = T.coverBilinear(wx, wy);
        if (c > 0.001) {
          const k = c * 0.7;
          r = lerp(r, 38, k);
          g = lerp(g, 66, k);
          b = lerp(b, 40, k);
        }

        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
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

    // Bucket by team → type → routing so fillStyle and dot size are set once per
    // group rather than per unit.
    for (let team = 0; team < this.styles.length; team++) {
      for (let type = 0; type < UNIT_TYPE_COUNT; type++) {
        const dot = Math.max(1, Math.round(1.5 * TYPE_SCALE[type] * zoom));
        for (let routing = 0; routing < 2; routing++) {
          ctx.fillStyle = this.styles[team][type][routing];
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
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
