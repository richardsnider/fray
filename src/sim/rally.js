// Rally-flag store — the single source of truth for march targets. One entry
// per flag: a stable id, the world-space point its followers march to, its
// team, and a short per-team code name ("a", "b", …) for the flag overlay.
// Units carry only a rallyId (units.js); the sim hot loop resolves it through
// byId() every tick, so moving a flag moves every follower with no per-unit
// copies to keep in sync. Squads mint one flag each at spawn (world.js), the
// player mints and moves them via sim/command.js, and a future AI director
// does the same through this module.

import * as U from './units.js';

const DEAD = U.STATE.DEAD;

const rallies = [];    // live flags in mint order (flag overlay + hit-testing iterate this)
const index = [];      // rally id → flag object (undefined once pruned): O(1) for the hot loop
const labelN = [0, 0]; // next label index per team
let nextId = 0;        // monotonic id source; ids stay valid across pruning

export const getRallies = () => rallies;
export const byId = (id) => index[id];

// Mint a flag for `team` at (x, y) and return its stable id.
export const mint = (x, y, team) => {
  const id = nextId++;
  const label = String.fromCharCode(97 + labelN[team]++);
  const ral = { id, x: 0, y: 0, team, label };
  rallies.push(ral);
  index[id] = ral;
  move(id, x, y);
  return id;
};

// Move a flag. Coordinates are quantized to f32 (fround): the flag is
// sim-consumed positional state, and the rest of the sim's positions live in
// Float32Arrays — keeping the numeric domain uniform keeps battles reproducible
// independent of where a coordinate happens to be stored.
export const move = (id, x, y) => {
  const ral = index[id];
  ral.x = Math.fround(x);
  ral.y = Math.fround(y);
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
