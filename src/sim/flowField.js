// Flow-field pathfinding. Instead of running A* per unit (the classic RTS
// performance trap), we compute one field for a whole army: a BFS "integration"
// pass floods outward from the goal over passable cells, then each cell stores a
// direction toward its lowest-distance neighbor. Every unit heading to that goal
// just samples its cell — O(1) per unit, and routes around impassable water for
// free.
//
// A field is plain data; the functions below read/mutate it as their first arg.

import { mag } from '../util/math.js';
import { cellIndexOf, sampleBilinear } from '../util/grid2d.js';

const INF = 1e9;

export const create = (worldW, worldH, cell) => {
  const cols = Math.ceil(worldW / cell) + 1;
  const rows = Math.ceil(worldH / cell) + 1;
  const n = cols * rows;
  return {
    cell, cols, rows,
    blocked: new Uint8Array(n),
    integ: new Float32Array(n),
    dirX: new Float32Array(n),
    dirY: new Float32Array(n),
    queue: new Int32Array(n), // BFS ring buffer (each cell enqueued once)
  };
};

// Mark impassable cells. fn(worldX, worldY) => truthy if blocked. Terrain is
// static, so this is called once at setup.
export const setBlocked = (ff, fn) => {
  const { cols, rows, cell, blocked } = ff;
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++)
      blocked[cy * cols + cx] = fn(cx * cell, cy * cell) ? 1 : 0;
};

const cellIndex = (ff, wx, wy) => cellIndexOf(wx, wy, ff.cell, ff.cols, ff.rows);

// Enqueue an unvisited, passable neighbor. Returns the new tail (unchanged if the
// cell is blocked or already reached at ≤ distance).
const visit = (ff, n, nd, tail) =>
  ff.blocked[n] || ff.integ[n] <= nd
    ? tail
    : (ff.integ[n] = nd, ff.queue[tail] = n, tail + 1);

// Rebuild the field for a new goal position.
export const compute = (ff, goalX, goalY) => {
  const { cols, rows, integ, blocked, queue, dirX, dirY } = ff;
  integ.fill(INF);

  let start = cellIndex(ff, goalX, goalY);
  blocked[start] && (start = nearestPassable(ff, start));
  if (start < 0) return void (dirX.fill(0), dirY.fill(0)); // unreachable goal

  // BFS (uniform cost, 4-neighbor) → integration/distance field.
  integ[start] = 0;
  let head = 0, tail = 0;
  queue[tail++] = start;
  while (head < tail) {
    const c = queue[head++];
    const nd = integ[c] + 1;
    const cx = c % cols;
    const cy = (c / cols) | 0;
    cx > 0        && (tail = visit(ff, c - 1, nd, tail));
    cx < cols - 1 && (tail = visit(ff, c + 1, nd, tail));
    cy > 0        && (tail = visit(ff, c - cols, nd, tail));
    cy < rows - 1 && (tail = visit(ff, c + cols, nd, tail));
  }

  buildFlow(ff);
};

// Per-cell flow direction = toward the 8-neighbor with the lowest distance.
const buildFlow = (ff) => {
  const { cols, rows, integ, blocked, dirX, dirY } = ff;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const c = cy * cols + cx;
      if (blocked[c] || integ[c] >= INF) { dirX[c] = dirY[c] = 0; continue; }
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
          v < best && (best = v, bx = ox, by = oy);
        }
      }
      // When no lower neighbor exists bx=by=0, so inv=0 zeroes the direction.
      const inv = bx || by ? 1 / mag(bx, by) : 0;
      dirX[c] = bx * inv;
      dirY[c] = by * inv;
    }
  }
};

// Bilinear-sample the flow direction at a world point into `out` (unit vector,
// or zero at the goal / unreachable cells).
export const sampleDir = (ff, wx, wy, out) => {
  const { cols, rows, cell, dirX, dirY } = ff;
  const dx = sampleBilinear(dirX, cols, rows, cell, wx, wy);
  const dy = sampleBilinear(dirY, cols, rows, cell, wx, wy);
  const m = mag(dx, dy);
  const k = m > 0.001 ? 1 / m : 0; // zero at the goal / unreachable cells
  out.x = dx * k;
  out.y = dy * k;
};

// If the goal landed in water, spiral outward to the closest passable cell.
const nearestPassable = (ff, idx) => {
  const { cols, rows, blocked } = ff;
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
};
