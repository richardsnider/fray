// The deterministic simulation core. Deliberately DOM-free and canvas-free so it
// can later run in a Web Worker or faster-than-realtime for balance testing.

import * as U from './units.js';
import { SpatialGrid } from './spatialGrid.js';
import {
  ARMY_SIZE, MAX_SPEED, SEEK_ACCEL, SEP_RADIUS, SEP_ACCEL, DAMPING,
} from '../config.js';

let W = 0;
let H = 0;
let grid = null;

// Per-team objective point. In the slice each team seeks the enemy's center of
// mass, so the armies clash on their own. A player click overrides team 0's.
const targets = [ { x: 0, y: 0 }, { x: 0, y: 0 } ];
let manualTarget0 = null;

export function init(width, height) {
  W = width;
  H = height;
  grid = new SpatialGrid(W, H, SEP_RADIUS);
  U.reset();
  spawnArmies();
}

export function resize(width, height) {
  W = width;
  H = height;
  grid.resize(W, H);
}

export function setManualTarget(x, y) {
  manualTarget0 = { x, y };
}

function spawnArmies() {
  // Team 0 clusters on the left quarter, team 1 on the right quarter.
  for (let i = 0; i < ARMY_SIZE; i++) {
    U.spawn(rand(W * 0.06, W * 0.24), rand(H * 0.2, H * 0.8), 0);
  }
  for (let i = 0; i < ARMY_SIZE; i++) {
    U.spawn(rand(W * 0.76, W * 0.94), rand(H * 0.2, H * 0.8), 1);
  }
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function updateTargets() {
  // Centroid per team → default objective is "advance on the enemy mass".
  let x0 = 0, y0 = 0, n0 = 0;
  let x1 = 0, y1 = 0, n1 = 0;
  for (let i = 0; i < U.count; i++) {
    if (U.team[i] === 0) { x0 += U.x[i]; y0 += U.y[i]; n0++; }
    else { x1 += U.x[i]; y1 += U.y[i]; n1++; }
  }
  if (n1) { targets[0].x = x1 / n1; targets[0].y = y1 / n1; }
  if (n0) { targets[1].x = x0 / n0; targets[1].y = y0 / n0; }
  if (manualTarget0) { targets[0].x = manualTarget0.x; targets[0].y = manualTarget0.y; }
}

export function step(dt) {
  const count = U.count;

  // Snapshot current positions as "previous" for render interpolation.
  U.px.set(U.x.subarray(0, count));
  U.py.set(U.y.subarray(0, count));

  updateTargets();
  grid.build(count, U.x, U.y);

  const { cell, cols, rows, heads, next } = grid;
  const sepR2 = SEP_RADIUS * SEP_RADIUS;

  for (let i = 0; i < count; i++) {
    const xi = U.x[i];
    const yi = U.y[i];
    const t = targets[U.team[i]];

    // Seek toward objective (unit vector).
    let ax = t.x - xi;
    let ay = t.y - yi;
    const d = Math.hypot(ax, ay);
    if (d > 0.001) { ax /= d; ay /= d; }
    ax *= SEEK_ACCEL;
    ay *= SEEK_ACCEL;

    // Separation: push away from neighbors in the surrounding 3x3 cells.
    let sx = 0, sy = 0;
    const cx = clampCell((xi / cell) | 0, cols);
    const cy = clampCell((yi / cell) | 0, rows);
    for (let oy = -1; oy <= 1; oy++) {
      const gy = cy + oy;
      if (gy < 0 || gy >= rows) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        if (gx < 0 || gx >= cols) continue;
        let j = heads[gy * cols + gx];
        while (j !== -1) {
          if (j !== i) {
            const dx = xi - U.x[j];
            const dy = yi - U.y[j];
            const dd = dx * dx + dy * dy;
            if (dd < sepR2 && dd > 0.0001) {
              const inv = 1 / Math.sqrt(dd);
              // Weight inversely by distance so close crowding pushes harder.
              sx += (dx * inv) * (SEP_RADIUS * inv);
              sy += (dy * inv) * (SEP_RADIUS * inv);
            }
          }
          j = next[j];
        }
      }
    }
    ax += sx * SEP_ACCEL;
    ay += sy * SEP_ACCEL;

    // Integrate velocity, damp, clamp to max speed, integrate position.
    let nvx = (U.vx[i] + ax * dt) * DAMPING;
    let nvy = (U.vy[i] + ay * dt) * DAMPING;
    const sp = Math.hypot(nvx, nvy);
    if (sp > MAX_SPEED) {
      const k = MAX_SPEED / sp;
      nvx *= k; nvy *= k;
    }
    U.vx[i] = nvx;
    U.vy[i] = nvy;

    let nx = xi + nvx * dt;
    let ny = yi + nvy * dt;
    if (nx < 0) nx = 0; else if (nx > W - 1) nx = W - 1;
    if (ny < 0) ny = 0; else if (ny > H - 1) ny = H - 1;
    U.x[i] = nx;
    U.y[i] = ny;
  }
}

function clampCell(c, max) {
  if (c < 0) return 0;
  if (c >= max) return max - 1;
  return c;
}
