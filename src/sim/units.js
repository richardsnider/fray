// Structure-of-Arrays unit store. Every field is a flat typed array indexed by
// unit id [0, count). This is the whole performance story: cache-friendly to
// iterate, zero per-unit allocation, and byte-for-byte ready to hand to WebGL
// later without touching the data model.

import { MAX_UNITS, TYPE_HP } from '../config.js';

export const px = new Float32Array(MAX_UNITS); // previous-tick position (for render interpolation)
export const py = new Float32Array(MAX_UNITS);
export const x = new Float32Array(MAX_UNITS);  // current position
export const y = new Float32Array(MAX_UNITS);
export const vx = new Float32Array(MAX_UNITS);
export const vy = new Float32Array(MAX_UNITS);
export const hp = new Float32Array(MAX_UNITS);
export const morale = new Float32Array(MAX_UNITS);
export const team = new Uint8Array(MAX_UNITS);
export const type = new Uint8Array(MAX_UNITS); // UnitType: 0 knight, 1 archer, 2 pike
export const state = new Uint8Array(MAX_UNITS);
export const selected = new Uint8Array(MAX_UNITS); // 1 if the player has this unit selected
export const cooldown = new Float32Array(MAX_UNITS); // type timer: archer reload / cavalry charge recovery
export const rallyX = new Float32Array(MAX_UNITS);   // default-AI march goal (enemy side of the field)
export const rallyY = new Float32Array(MAX_UNITS);

export const STATE = { ACTIVE: 0, ROUTING: 1, DEAD: 2 };

// `count` is exported live: importers see it grow via the module binding.
export let count = 0;

export const spawn = (sx, sy, t, ut, rx = sx, ry = sy) => {
  const i = count++;
  px[i] = x[i] = sx;
  py[i] = y[i] = sy;
  vx[i] = vy[i] = 0;
  hp[i] = TYPE_HP[ut];
  morale[i] = 100;
  team[i] = t;
  type[i] = ut;
  state[i] = STATE.ACTIVE;
  selected[i] = 0;
  cooldown[i] = 0;
  rallyX[i] = rx;
  rallyY[i] = ry;
  return i;
};

export const reset = () => { count = 0; };

// Copy every field of unit `src` into slot `dst`.
const copyUnit = (dst, src) => {
  px[dst] = px[src]; py[dst] = py[src];
  x[dst] = x[src]; y[dst] = y[src];
  vx[dst] = vx[src]; vy[dst] = vy[src];
  hp[dst] = hp[src]; morale[dst] = morale[src];
  team[dst] = team[src]; type[dst] = type[src]; state[dst] = state[src];
  selected[dst] = selected[src];
  cooldown[dst] = cooldown[src];
  rallyX[dst] = rallyX[src]; rallyY[dst] = rallyY[src];
};

// Remove units flagged DEAD by swapping the last live unit into their slot.
// O(count), allocation-free. The grid is rebuilt every tick so shifted indices
// are harmless, and prev-position is refreshed at the top of the next step.
// `--count` shrinks the live range in place; a DEAD slot pulls the (new) last
// unit down over it and holds `i` so the pulled-in unit is checked next.
export const compactDead = () => {
  let i = 0;
  while (i < count)
    state[i] === STATE.DEAD ? (i !== --count && copyUnit(i, count)) : i++;
};
