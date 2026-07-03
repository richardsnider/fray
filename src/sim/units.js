// Structure-of-Arrays unit store. Every field is a flat typed array indexed by
// unit id [0, count). This is the whole performance story: cache-friendly to
// iterate, zero per-unit allocation, and byte-for-byte ready to hand to WebGL
// later without touching the data model.

import { MAX_UNITS } from '../config.js';

export const px = new Float32Array(MAX_UNITS); // previous-tick position (for render interpolation)
export const py = new Float32Array(MAX_UNITS);
export const x = new Float32Array(MAX_UNITS);  // current position
export const y = new Float32Array(MAX_UNITS);
export const vx = new Float32Array(MAX_UNITS);
export const vy = new Float32Array(MAX_UNITS);
export const hp = new Float32Array(MAX_UNITS);
export const morale = new Float32Array(MAX_UNITS);
export const team = new Uint8Array(MAX_UNITS);
export const type = new Uint8Array(MAX_UNITS); // reserved: knight/archer/pike/...
export const state = new Uint8Array(MAX_UNITS);

export const STATE = { ACTIVE: 0, ROUTING: 1, DEAD: 2 };

// `count` is exported live: importers see it grow via the module binding.
export let count = 0;

export function spawn(sx, sy, t) {
  const i = count++;
  px[i] = x[i] = sx;
  py[i] = y[i] = sy;
  vx[i] = vy[i] = 0;
  hp[i] = 100;
  morale[i] = 100;
  team[i] = t;
  type[i] = 0;
  state[i] = STATE.ACTIVE;
  return i;
}

export function reset() {
  count = 0;
}

// Remove units flagged DEAD by swapping the last live unit into their slot.
// O(count), allocation-free. The grid is rebuilt every tick so shifted indices
// are harmless, and prev-position is refreshed at the top of the next step.
export function compactDead() {
  let i = 0;
  while (i < count) {
    if (state[i] === STATE.DEAD) {
      const j = count - 1;
      if (i !== j) {
        px[i] = px[j]; py[i] = py[j];
        x[i] = x[j]; y[i] = y[j];
        vx[i] = vx[j]; vy[i] = vy[j];
        hp[i] = hp[j]; morale[i] = morale[j];
        team[i] = team[j]; type[i] = type[j]; state[i] = state[j];
      }
      count--;
    } else {
      i++;
    }
  }
}
