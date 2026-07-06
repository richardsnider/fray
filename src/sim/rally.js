// Rally-flag store — the single source of truth for march targets. One entry
// per flag: a stable id, the world-space point its followers march to, its
// team, and a short per-team code name ("a", "b", …) for the flag overlay.
// Units carry only a rallyId (units.js); the sim hot loop resolves it through
// byId() every tick, so moving a flag moves every follower with no per-unit
// copies to keep in sync. Squads mint one flag each at spawn (world.js), the
// player mints and moves them via sim/command.js, and a future AI director
// does the same through this module.

import * as U from './units.js';
import { Formation, FACING_EPS } from '../config.js';
import { mag } from '../util/math.js';

const DEAD = U.STATE.DEAD;

const rallies = [];    // live flags in mint order (flag overlay + hit-testing iterate this)
const index = [];      // rally id → flag object (undefined once pruned): O(1) for the hot loop
const labelN = [0, 0]; // next label index per team
let nextId = 0;        // monotonic id source; ids stay valid across pruning

export const getRallies = () => rallies;
export const byId = (id) => index[id];

// Mint a flag for `team` at (x, y) and return its stable id. Facing (fx, fy —
// a unit vector) defaults toward the enemy side (team 0 deploys left) until
// move() re-derives it from displacement; `form` is the formation its followers
// hold, and `cols` the formation's rank width — 0 until sim/formation.js deals
// slots (0 = unslotted, followers seek the bare flag point).
export const mint = (x, y, team) => {
  const id = nextId++;
  const label = String.fromCharCode(97 + labelN[team]++);
  const ral = {
    id, x: Math.fround(x), y: Math.fround(y), team, label,
    fx: team === 0 ? 1 : -1, fy: 0, form: Formation.BLOCK, cols: 0,
  };
  rallies.push(ral);
  index[id] = ral;
  return id;
};

// Move a flag. Coordinates are quantized to f32 (fround): the flag is
// sim-consumed positional state, and the rest of the sim's positions live in
// Float32Arrays — keeping the numeric domain uniform keeps battles reproducible
// independent of where a coordinate happens to be stored. A meaningful move
// (beyond FACING_EPS, so nudges don't wheel the whole block) also re-derives
// the facing, so an ordered squad forms up fronting its direction of travel.
export const move = (id, x, y) => {
  const ral = index[id];
  const nx = Math.fround(x);
  const ny = Math.fround(y);
  const d = mag(nx - ral.x, ny - ral.y);
  d > FACING_EPS && (ral.fx = Math.fround((nx - ral.x) / d), ral.fy = Math.fround((ny - ral.y) / d));
  ral.x = nx;
  ral.y = ny;
};

// Drop flags no living unit follows any more (emptied squads, moved-off
// groups). Cheap and only run on command, so ghost flags never linger.
export const prune = () => {
  const live = new Set();
  for (let i = 0; i < U.count; i++) U.state[i] !== DEAD && live.add(U.rallyId[i]);
  for (let k = rallies.length - 1; k >= 0; k--)
    live.has(rallies[k].id) || (index[rallies[k].id] = undefined, rallies.splice(k, 1));
};

export const reset = () => {
  rallies.length = 0;
  index.length = 0;
  labelN[0] = labelN[1] = 0;
  nextId = 0;
};
