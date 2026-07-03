// Flow-field pathfinding. Instead of running A* per unit (the classic RTS
// performance trap), we compute one field for a whole army: a BFS "integration"
// pass floods outward from the goal over passable cells, then each cell stores a
// direction toward its lowest-distance neighbor. Every unit heading to that goal
// just samples its cell — O(1) per unit, and routes around impassable water for
// free.

const INF = 1e9;

export class FlowField {
  constructor(worldW, worldH, cell) {
    this.cell = cell;
    this.cols = Math.ceil(worldW / cell) + 1;
    this.rows = Math.ceil(worldH / cell) + 1;
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.integ = new Float32Array(n);
    this.dirX = new Float32Array(n);
    this.dirY = new Float32Array(n);
    this.queue = new Int32Array(n); // BFS ring buffer (each cell enqueued once)
  }

  // Mark impassable cells. fn(worldX, worldY) => truthy if blocked. Terrain is
  // static, so this is called once at setup.
  setBlocked(fn) {
    const { cols, rows, cell, blocked } = this;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        blocked[cy * cols + cx] = fn(cx * cell, cy * cell) ? 1 : 0;
      }
    }
  }

  cellIndex(wx, wy) {
    let cx = (wx / this.cell) | 0;
    let cy = (wy / this.cell) | 0;
    if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  // Rebuild the field for a new goal position.
  compute(goalX, goalY) {
    const { cols, rows, integ, blocked, queue } = this;
    integ.fill(INF);

    let start = this.cellIndex(goalX, goalY);
    if (blocked[start]) start = this.nearestPassable(start);
    if (start < 0) { this.dirX.fill(0); this.dirY.fill(0); return; }

    // BFS (uniform cost, 4-neighbor) → integration/distance field.
    integ[start] = 0;
    let head = 0, tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++];
      const nd = integ[c] + 1;
      const cx = c % cols;
      const cy = (c / cols) | 0;
      if (cx > 0)        tail = this.visit(c - 1, nd, queue, tail);
      if (cx < cols - 1) tail = this.visit(c + 1, nd, queue, tail);
      if (cy > 0)        tail = this.visit(c - cols, nd, queue, tail);
      if (cy < rows - 1) tail = this.visit(c + cols, nd, queue, tail);
    }

    this.buildFlow();
  }

  // Enqueue an unvisited, passable neighbor. Returns the new tail.
  visit(n, nd, queue, tail) {
    if (this.blocked[n]) return tail;
    if (this.integ[n] <= nd) return tail; // already reached at <= distance
    this.integ[n] = nd;
    queue[tail++] = n;
    return tail;
  }

  // Per-cell flow direction = toward the 8-neighbor with the lowest distance.
  buildFlow() {
    const { cols, rows, integ, blocked, dirX, dirY } = this;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const c = cy * cols + cx;
        if (blocked[c] || integ[c] >= INF) { dirX[c] = 0; dirY[c] = 0; continue; }
        let best = integ[c];
        let bx = 0, by = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = cy + oy;
          if (ny < 0 || ny >= rows) continue;
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = cx + ox;
            if (nx < 0 || nx >= cols) continue;
            const v = integ[ny * cols + nx];
            if (v < best) { best = v; bx = ox; by = oy; }
          }
        }
        if (bx || by) {
          const inv = 1 / Math.hypot(bx, by);
          dirX[c] = bx * inv;
          dirY[c] = by * inv;
        } else {
          dirX[c] = 0; dirY[c] = 0;
        }
      }
    }
  }

  // Bilinear-sample the flow direction at a world point into `out` (unit vector,
  // or zero at the goal / unreachable cells).
  sampleDir(wx, wy, out) {
    const { cols, rows, cell, dirX, dirY } = this;
    const fx = wx / cell;
    const fy = wy / cell;
    let x0 = Math.floor(fx);
    let y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    if (x0 < 0) x0 = 0; else if (x0 > cols - 1) x0 = cols - 1;
    if (y0 < 0) y0 = 0; else if (y0 > rows - 1) y0 = rows - 1;
    const x1 = x0 + 1 < cols ? x0 + 1 : x0;
    const y1 = y0 + 1 < rows ? y0 + 1 : y0;
    const i00 = y0 * cols + x0, i01 = y0 * cols + x1;
    const i10 = y1 * cols + x0, i11 = y1 * cols + x1;
    const dx = lerp(lerp(dirX[i00], dirX[i01], tx), lerp(dirX[i10], dirX[i11], tx), ty);
    const dy = lerp(lerp(dirY[i00], dirY[i01], tx), lerp(dirY[i10], dirY[i11], tx), ty);
    const m = Math.hypot(dx, dy);
    if (m > 0.001) { out.x = dx / m; out.y = dy / m; }
    else { out.x = 0; out.y = 0; }
  }

  // If the goal landed in water, spiral outward to the closest passable cell.
  nearestPassable(idx) {
    const { cols, rows, blocked } = this;
    const cx = idx % cols;
    const cy = (idx / cols) | 0;
    for (let r = 1; r <= 24; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const nx = cx + dx;
          if (nx < 0 || nx >= cols) continue;
          const ni = ny * cols + nx;
          if (!blocked[ni]) return ni;
        }
      }
    }
    return -1;
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
