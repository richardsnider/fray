// Rank-and-file formation slots. A rally flag (sim/rally.js) carries a facing
// and a formation type; each follower holds a slot (units.js) — an index into a
// cols-wide grid of points extending back from the flag, oriented to its facing
// — and world.js marches the unit to its slot instead of the bare flag point,
// so a squad settles into ranks instead of a ball. Slots are dealt here only on
// events — player commands, spawn, a slow healing cadence (REFORM_TICKS) —
// never per tick; between deals a unit keeps its slot, so casualties leave gaps
// in the ranks until the next deal closes them. Formation is best-effort by
// design: engaged and routing units ignore their slot, and a slot over water
// just parks its unit on the shoreline via the usual avoidance.

import * as U from './units.js';
import * as Rally from './rally.js';
import { FORM_ASPECT, FORM_SPACING } from '../config.js';

const DEAD = U.STATE.DEAD;

// World position of slot `s` of flag `ral`. Columns sit centered on the flag's
// lateral axis (-fy, fx); ranks extend backward along -facing, so the front
// rank arrives exactly at the flag. New formation shapes (wedge etc.) branch on
// ral.form here and in the deal below.
export const slotX = (ral, s) => {
  const pitch = FORM_SPACING[ral.form];
  return ral.x
    - ral.fy * ((s % ral.cols - (ral.cols - 1) * 0.5) * pitch)
    - ral.fx * (((s / ral.cols) | 0) * pitch);
};
export const slotY = (ral, s) => {
  const pitch = FORM_SPACING[ral.form];
  return ral.y
    + ral.fx * ((s % ral.cols - (ral.cols - 1) * 0.5) * pitch)
    - ral.fy * (((s / ral.cols) | 0) * pitch);
};

// Deal slots to a flag's live followers: front-most units take the front rank,
// each rank filled across the lateral axis, so the deal matches where everyone
// already stands and nobody crosses the block to reach a slot — this is also
// what keeps a marching squad in shape, since parallel paths to a matched deal
// don't cross. Event-rate work, so the gather array and sorts are fine here;
// the per-tick hot loop only reads the dealt slots.
export const reassign = (ral) => {
  const f = [];
  if (FORM_SPACING[ral.form] > 0)
    for (let i = 0; i < U.count; i++)
      U.state[i] !== DEAD && U.rallyId[i] === ral.id && f.push(i);
  if (f.length === 0) { ral.cols = 0; return; } // unslotted: followers seek the flag itself
  const { fx, fy } = ral;
  const fwd = (i) => U.x[i] * fx + U.y[i] * fy; // projection along facing
  const lat = (i) => U.y[i] * fx - U.x[i] * fy; // projection along the lateral axis
  ral.cols = Math.max(1, Math.round(Math.sqrt(f.length * FORM_ASPECT[ral.form])));
  f.sort((a, b) => fwd(b) - fwd(a));
  for (let s = 0; s < f.length; s += ral.cols) {
    const rank = f.slice(s, s + ral.cols).sort((a, b) => lat(a) - lat(b));
    for (let k = 0; k < rank.length; k++) U.slot[rank[k]] = s + k;
  }
};

export const reassignAll = () => { for (const ral of Rally.getRallies()) reassign(ral); };
