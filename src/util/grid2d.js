// Shared helpers for the uniform world-space grids (terrain, flow fields,
// spatial hash). Every grid module stores flat row-major arrays plus
// { cell, cols, rows }, so these take those as plain args, stay allocation-free,
// and inline like the math helpers. This is the single home for the
// "world coord → clamped cell" idiom and edge-clamped bilinear sampling that
// had been re-implemented per grid.

import { lerp, clampIndex } from './math.js';

// World coordinate → clamped cell coordinate along one axis.
export const cellCoord = (w, cell, len) => clampIndex((w / cell) | 0, len);

// World point → flat row-major cell index.
export const cellIndexOf = (wx, wy, cell, cols, rows) =>
  cellCoord(wy, cell, rows) * cols + cellCoord(wx, cell, cols);

// Bilinear sample of a flat grid at a world point, clamped at the edges.
export const sampleBilinear = (grid, cols, rows, cell, wx, wy) => {
  const fx = wx / cell;
  const fy = wy / cell;
  const fx0 = Math.floor(fx);
  const fy0 = Math.floor(fy);
  const tx = fx - fx0;
  const ty = fy - fy0;
  const x0 = clampIndex(fx0, cols);
  const y0 = clampIndex(fy0, rows);
  const x1 = x0 + 1 < cols ? x0 + 1 : x0;
  const y1 = y0 + 1 < rows ? y0 + 1 : y0;
  const r0 = y0 * cols;
  const r1 = y1 * cols;
  return lerp(lerp(grid[r0 + x0], grid[r0 + x1], tx), lerp(grid[r1 + x0], grid[r1 + x1], tx), ty);
};
