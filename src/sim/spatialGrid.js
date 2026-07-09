// Uniform spatial hash grid using an intrusive linked list (heads + next).
// Rebuilt every tick — cheap — and turns "who is near me?" from O(n^2) into an
// O(1)-ish 3x3 cell walk. Uniform grid beats a quadtree here: units are roughly
// evenly distributed and this is far simpler with no allocation per frame.
//
// A grid is plain data: { cell, cols, rows, heads, next }. build() mutates it.

import { MAX_UNITS } from '../config.js';
import { cellCoord } from '../util/grid2d.js';

export const create = (width, height, cell) => {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  return {
    cell, cols, rows,
    heads: new Int32Array(cols * rows),
    next: new Int32Array(MAX_UNITS),
    // Per-team occupant counts per cell, so scans wider than the 3×3 core
    // (polearm reach) can skip enemy-empty cells without walking anyone.
    teamCounts: [new Uint16Array(cols * rows), new Uint16Array(cols * rows)],
  };
};

export const build = (g, count, xs, ys, teams) => {
  const { cell, cols, rows, heads, next, teamCounts } = g;
  heads.fill(-1);
  const t0 = teamCounts[0], t1 = teamCounts[1];
  t0.fill(0);
  t1.fill(0);
  for (let i = 0; i < count; i++) {
    const cx = cellCoord(xs[i], cell, cols);
    const cy = cellCoord(ys[i], cell, rows);
    const c = cy * cols + cx;
    next[i] = heads[c];
    heads[c] = i;
    (teams[i] === 0 ? t0 : t1)[c]++;
  }
};
