// Player command + selection layer. A subset of team-0 units is `selected`
// (a flag on the unit, see units.js); the player commands a selection by
// repointing (or minting) the rally flag it follows (sim/rally.js). There is
// no separate movement override — units keep marching to their flag
// (world.js), so orders survive re-selection and units engage enemies met en
// route. Called by the input layer, which receives this module via dependency
// injection — so static analysis can't see the edges.

import * as U from './units.js';
import * as Rally from './rally.js';
import * as Formation from './formation.js';
import { Arch } from '../config.js';

const DEAD = U.STATE.DEAD;
const { KNIGHTS, PIKEMEN } = Arch;

// Provenance of the current player selection: the rally id it was grabbed from
// (selectByRally), or -1 when it's a fresh box-select with no flag behind it.
// commandSelected reuses this flag rather than re-deriving it from the selection.
let commandRally = -1;

// Forget the provenance (new battle). A stale id could otherwise collide with
// a freshly minted flag — ids restart from 0 — and drag the wrong squad's flag.
export const reset = () => { commandRally = -1; };

// Shared scan predicates. `liveOwn` is a unit the player owns and can still act
// on — team 0 and not dead (dead units are compacted out each tick but can
// linger mid-step); `liveSelected` narrows that to the current selection (only
// team-0 units are ever selected, so the team check is redundant-but-safe). Every
// selection/command/HUD loop below filters through one of these.
const liveOwn = (i) => U.team[i] === 0 && U.state[i] !== DEAD;
const liveSelected = (i) => liveOwn(i) && U.selected[i] === 1;

// Select every live team-0 unit inside the world-space rectangle, replacing the
// previous selection. An empty box (a bare click) clears the selection.
// fallow-ignore-next-line unused-export
export const selectInRect = (x0, y0, x1, y1) => {
  const xlo = Math.min(x0, x1), xhi = Math.max(x0, x1);
  const ylo = Math.min(y0, y1), yhi = Math.max(y0, y1);
  for (let i = 0; i < U.count; i++) {
    const hit = liveOwn(i) &&
      U.x[i] >= xlo && U.x[i] <= xhi && U.y[i] >= ylo && U.y[i] <= yhi;
    U.selected[i] = hit ? 1 : 0;
  }
  commandRally = -1; // a freshly boxed group has no flag behind it
};

// Select every live team-0 unit that follows the rally flag `id`, replacing the
// previous selection — the click-a-flag-to-grab-its-squad gesture.
// fallow-ignore-next-line unused-export
export const selectByRally = (id) => {
  for (let i = 0; i < U.count; i++)
    U.selected[i] = (liveOwn(i) && U.rallyId[i] === id) ? 1 : 0;
  commandRally = id; // remember the flag this selection was grabbed from
};

// Command the current selection to a world point. The selection carries a
// provenance flag (commandRally): a squad grabbed by its flag moves that flag —
// and repeat commands drag the same one — while a freshly boxed group mints a new
// flag, leaving any unselected squad-mates on their old objective. Either way the
// units keep marching to their rally, so they engage enemies met en route.
// fallow-ignore-next-line unused-export
export const commandSelected = (x, y) => {
  // Selection head count + centroid in one pass: the centroid seeds a fresh
  // flag's position, so the facing Rally.move derives from the displacement
  // points from where the troops stand toward the ordered point.
  let n = 0, cx = 0, cy = 0;
  for (let i = 0; i < U.count; i++)
    liveSelected(i) && (n++, cx += U.x[i], cy += U.y[i]);
  if (n === 0) return;

  // Reuse the flag the selection came from if it still exists, else mint one;
  // remember it so the next command to this same selection drags it along.
  const targetId = commandRally >= 0 && Rally.byId(commandRally) ? commandRally : Rally.mint(cx / n, cy / n, 0);
  commandRally = targetId;

  Rally.move(targetId, x, y);
  for (let i = 0; i < U.count; i++) liveSelected(i) && (U.rallyId[i] = targetId);
  Rally.prune();
  // Deal the (possibly re-composed) following its formation slots right away —
  // the slow cadence in world.js would leave it balling for up to REFORM_TICKS.
  Formation.reassign(Rally.byId(targetId));
};

// Count selected live units by archetype for the HUD. Recomputed on demand so
// it stays honest as selected units die. Returned object is reused.
const selCounts = { knight: 0, archer: 0, pike: 0, total: 0 };
export const getSelectionCounts = () => {
  selCounts.knight = selCounts.archer = selCounts.pike = selCounts.total = 0;
  for (let i = 0; i < U.count; i++) {
    if (!liveSelected(i)) continue;
    selCounts.total++;
    const t = U.arch[i];
    t === KNIGHTS ? selCounts.knight++ : t === PIKEMEN ? selCounts.pike++ : selCounts.archer++;
  }
  return selCounts;
};
