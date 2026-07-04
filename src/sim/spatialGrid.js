// Uniform spatial hash grid using an intrusive linked list (heads + next).
// Rebuilt every tick — cheap — and turns "who is near me?" from O(n^2) into an
// O(1)-ish 3x3 cell walk. Uniform grid beats a quadtree here: units are roughly
// evenly distributed and this is far simpler with no allocation per frame.
//
// A grid is plain data: { cell, cols, rows, heads, next }. build() mutates it.

import { MAX_UNITS } from '../config.js';
import { clampIndex } from '../util/math.js';

export const create = (width, height, cell) => {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  return {
    cell, cols, rows,
    heads: new Int32Array(cols * rows),
    next: new Int32Array(MAX_UNITS),
  };
};

export const build = (g, count, xs, ys) => {
  const { cell, cols, rows, heads, next } = g;
  heads.fill(-1);
  for (let i = 0; i < count; i++) {
    const cx = clampIndex((xs[i] / cell) | 0, cols);
    const cy = clampIndex((ys[i] / cell) | 0, rows);
    const c = cy * cols + cx;
    next[i] = heads[c];
    heads[c] = i;
  }
};
