// Uniform spatial hash grid using an intrusive linked list (heads + next).
// Rebuilt every tick — cheap — and turns "who is near me?" from O(n^2) into an
// O(1)-ish 3x3 cell walk. Uniform grid beats a quadtree here: units are roughly
// evenly distributed and this is far simpler with no allocation per frame.

import { MAX_UNITS } from '../config.js';

export class SpatialGrid {
  constructor(width, height, cell) {
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.heads = new Int32Array(this.cols * this.rows);
    this.next = new Int32Array(MAX_UNITS);
  }

  resize(width, height) {
    this.cols = Math.max(1, Math.ceil(width / this.cell));
    this.rows = Math.max(1, Math.ceil(height / this.cell));
    this.heads = new Int32Array(this.cols * this.rows);
  }

  cellCoord(v, max) {
    let c = v | 0;
    if (c < 0) c = 0; else if (c >= max) c = max - 1;
    return c;
  }

  build(count, xs, ys) {
    this.heads.fill(-1);
    const { cell, cols, rows, heads, next } = this;
    for (let i = 0; i < count; i++) {
      const cx = this.cellCoord((xs[i] / cell) | 0, cols);
      const cy = this.cellCoord((ys[i] / cell) | 0, rows);
      const c = cy * cols + cx;
      next[i] = heads[c];
      heads[c] = i;
    }
  }
}
