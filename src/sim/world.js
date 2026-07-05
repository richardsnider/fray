// The deterministic simulation core. Deliberately DOM-free and canvas-free so it
// can later run in a Web Worker or faster-than-realtime for balance testing.

import * as U from './units.js';
import * as T from './terrain.js';
import * as Grid from './spatialGrid.js';
import * as Archery from './archery.js';
import { mulberry32 } from './rng.js';
import { clamp, clampIndex, mag } from '../util/math.js';
import { cellCoord } from '../util/grid2d.js';
import {
  MAX_UNITS, WORLD_W, WORLD_H, ARMY_SIZE, SEEK_ACCEL, SEP_RADIUS, SEP_ACCEL, DAMPING,
  MAX_STEER_SPEED, ATTACK_RANGE, FLEE_SPEED_MULT,
  MORALE_MAX, ROUT_THRESHOLD, RALLY_THRESHOLD, MORALE_REGEN,
  FEAR_OUTNUMBERED, FEAR_PANIC, HIT_FEAR,
  SLOPE_SPEED, COVER_SLOW, HEIGHT_DMG, WATER_LOOK, WATER_AVOID,
  UnitType, UNIT_TYPE_COUNT, ARMY_MIX, SQUAD_SIZE, SQUAD_RADIUS,
  TYPE_SPEED_MULT, TYPE_MELEE_DPS, TYPE_ARMOR, DMG_MULT,
  CHARGE_MIN_SPEED, CHARGE_DMG, CHARGE_MORALE, CHARGE_COOLDOWN,
} from '../config.js';

const { ACTIVE, ROUTING, DEAD } = U.STATE;
const { KNIGHT, PIKE } = UnitType;

const W = WORLD_W;
const H = WORLD_H;
let grid = null;        // fine grid (SEP_RADIUS) for separation + melee
let archery = null;     // volley aim grid + pending-impact queue (sim/archery.js)

let tick = 0;

// Incoming damage is accumulated here during the scan and applied after the full
// pass, so kill resolution doesn't depend on unit iteration order.
const dmg = new Float32Array(MAX_UNITS);

// Player control: a subset of team-0 units is `selected` (flag on the unit).
// Every unit always marches to its own rally point; the player commands a
// selection by repointing (or minting) the rally flag it follows — there is no
// separate override, so orders survive re-selection and read straight off the
// same rallyX/rallyY the sim already uses.

// Live counts for the HUD, refreshed each tick.
const stats = { team0: 0, team1: 0 };

// Seeded RNG for spawn placement / type rolls; reset in init() so one seed
// reproduces the whole battle. Decorrelated from the terrain seed via XOR.
let rng = Math.random;

// One entry per rally flag: a stable id, the world-space point units march to,
// its team, and a short per-team code name ("a", "b", …) for the overlay. Squads
// seed one each at spawn; the player mints more by commanding a selection.
const rallies = [];
const rallyLabelN = [0, 0]; // next label index per team, reset each init
let rallyNextId = 0;        // monotonic id source; ids stay valid across pruning
// Provenance of the current player selection: the rally id it was grabbed from
// (selectByRally), or -1 when it's a fresh box-select with no flag behind it.
// commandSelected reuses this flag rather than re-deriving it from the selection.
let commandRally = -1;
export const getRallies = () => rallies;

// Create a rally flag for `team` at (x, y) and return its stable id.
const newRally = (x, y, team) => {
  const id = rallyNextId++;
  const label = String.fromCharCode(97 + rallyLabelN[team]++);
  rallies.push({ id, x, y, team, label });
  return id;
};

const rallyById = (id) => rallies.find((r) => r.id === id);

// Drop flags no living unit follows any more (emptied squads, moved-off groups).
// Cheap and only run on command, so ghost flags never linger on the field.
const pruneRallies = () => {
  const live = new Set();
  for (let i = 0; i < U.count; i++) U.state[i] !== DEAD && live.add(U.rallyId[i]);
  for (let k = rallies.length - 1; k >= 0; k--) live.has(rallies[k].id) || rallies.splice(k, 1);
};

export const init = (seed = 0) => {
  rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  T.generate(seed);
  grid = Grid.create(W, H, SEP_RADIUS);
  archery = Archery.create();
  tick = 0;
  deaths.n = 0;
  rallies.length = 0;
  rallyLabelN[0] = rallyLabelN[1] = 0;
  rallyNextId = 0;
  commandRally = -1;
  U.reset();
  spawnArmies();
};

// Player command + selection API. Called by the input layer, which receives
// `world` via dependency injection — so static analysis can't see the edges.

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
  let anySel = false;
  for (let i = 0; i < U.count && !anySel; i++) anySel = liveSelected(i);
  if (!anySel) return;

  // Reuse the flag the selection came from if it still exists, else mint one;
  // remember it so the next command to this same selection drags it along.
  const targetId = commandRally >= 0 && rallyById(commandRally) ? commandRally : newRally(x, y, 0);
  commandRally = targetId;

  const ral = rallyById(targetId);
  ral.x = x; ral.y = y;
  for (let i = 0; i < U.count; i++) {
    if (liveSelected(i)) {
      U.rallyId[i] = targetId;
      U.rallyX[i] = x; U.rallyY[i] = y;
    }
  }
  pruneRallies();
};

// Count selected live units by type for the HUD. Recomputed on demand so it
// stays honest as selected units die. Returned object is reused.
const selCounts = { knight: 0, archer: 0, pike: 0, total: 0 };
export const getSelectionCounts = () => {
  selCounts.knight = selCounts.archer = selCounts.pike = selCounts.total = 0;
  for (let i = 0; i < U.count; i++) {
    if (!liveSelected(i)) continue;
    selCounts.total++;
    const t = U.type[i];
    t === KNIGHT ? selCounts.knight++ : t === PIKE ? selCounts.pike++ : selCounts.archer++;
  }
  return selCounts;
};

export const getStats = () => stats;

// Read-only views for the renderer: in-flight volleys come straight off the
// archery ring buffer, and the tick anchors their flight interpolation.
export const getArchery = () => archery;
export const getTick = () => tick;

// Death log for the renderer (blood decals): positions of units killed since
// the consumer last reset `n`. Write-only for the sim — determinism unaffected.
export const deaths = { x: new Float32Array(MAX_UNITS), y: new Float32Array(MAX_UNITS), n: 0 };

const spawnArmies = () => {
  spawnArmy(W * 0.06, W * 0.24, 0);
  spawnArmy(W * 0.76, W * 0.94, 1);
};

// Deploy an army into its zone [x0,x1] x [y0,y1] as clustered single-type
// squads, so each type reads as a coherent group instead of an intermixed soup.
// Per-type counts follow ARMY_MIX; the last type absorbs any rounding remainder
// so the total stays exactly ARMY_SIZE.
const spawnArmy = (x0, x1, team) => {
  const y0 = H * 0.2, y1 = H * 0.8;
  let placed = 0;
  for (let t = 0; t < UNIT_TYPE_COUNT; t++) {
    const count = t === UNIT_TYPE_COUNT - 1
      ? ARMY_SIZE - placed
      : Math.round(ARMY_SIZE * ARMY_MIX[t]);
    for (let n = count; n > 0; n -= SQUAD_SIZE) {
      spawnSquad(x0, x1, y0, y1, team, t, Math.min(SQUAD_SIZE, n));
    }
    placed += count;
  }
};

// Scatter n units of one type in a disk around a random deploy point. The center
// is kept a radius inside the zone so the squad stays within its army's area.
// Each squad also gets its own rally point somewhere on the enemy's half of the
// field, so squads fan out toward scattered objectives and the battle breaks
// into several fronts instead of collapsing into one central mob.
const spawnSquad = (x0, x1, y0, y1, team, type, n) => {
  const r = SQUAD_RADIUS;
  const cx = rand(Math.min(x0 + r, x1), Math.max(x1 - r, x0));
  const cy = rand(Math.min(y0 + r, y1), Math.max(y1 - r, y0));
  // Rally on the far side: team 0 (deploys left) heads right, team 1 vice-versa.
  const rx = team === 0 ? rand(W * 0.55, W * 0.92) : rand(W * 0.08, W * 0.45);
  const ry = rand(H * 0.1, H * 0.9);
  // Record it for the flag overlay, tagged with a short per-team code name.
  const rid = newRally(rx, ry, team);
  for (let i = 0; i < n; i++) {
    let x = cx, y = cy, tries = 0;
    // Uniform-in-disk offset; reject water so nobody spawns stranded, falling
    // back to the squad center after a few tries.
    do {
      const ang = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * r;
      x = cx + Math.cos(ang) * rad;
      y = cy + Math.sin(ang) * rad;
    } while (T.isWaterAt(x, y) && ++tries < 8);
    U.spawn(x, y, team, type, rx, ry, rid);
  }
};

const rand = (a, b) => a + rng() * (b - a);

const updateStats = () => {
  // Live per-team head count for the HUD.
  let a0 = 0, a1 = 0;
  for (let i = 0; i < U.count; i++) U.team[i] === 0 ? a0++ : a1++;
  stats.team0 = a0;
  stats.team1 = a1;
};

export const step = (dt) => {
  const count = U.count;

  // Snapshot current positions as "previous" for render interpolation.
  U.px.set(U.x.subarray(0, count));
  U.py.set(U.y.subarray(0, count));

  updateStats();
  tick++;

  Grid.build(grid, count, U.x, U.y);

  const { cell, cols, rows, heads, next } = grid;
  const scanR2 = SEP_RADIUS * SEP_RADIUS;   // separation / awareness radius
  const attackR2 = ATTACK_RANGE * ATTACK_RANGE;

  for (let i = 0; i < count; i++) {
    const xi = U.x[i];
    const yi = U.y[i];
    const teami = U.team[i];
    const statei = U.state[i];
    const typei = U.type[i];
    // This unit's terrain cell, shared by the combat height bonus and the
    // movement cover/slope factors below.
    const tcx = cellCoord(xi, T.CELL, T.cols);
    const tcy = cellCoord(yi, T.CELL, T.rows);
    const tcell = tcy * T.cols + tcx;
    U.cooldown[i] > 0 && (U.cooldown[i] -= dt); // archer reload / charge recovery

    // --- neighbor scan: separation (friends), plus enemy/friend awareness -----
    let sx = 0, sy = 0;
    let friendClose = 0;
    let enemyClose = 0;
    let routNear = 0;
    let ceIdx = -1;         // closest enemy
    let ceD2 = Infinity;

    const cx = cellCoord(xi, cell, cols);
    const cy = cellCoord(yi, cell, rows);
    for (let oy = -1; oy <= 1; oy++) {
      const gy = cy + oy;
      if (gy < 0 || gy >= rows) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        if (gx < 0 || gx >= cols) continue;
        let j = heads[gy * cols + gx];
        while (j !== -1) {
          if (j !== i) {
            const dx = xi - U.x[j];
            const dy = yi - U.y[j];
            const dd = dx * dx + dy * dy;
            if (dd < scanR2 && dd > 0.0001) {
              // friend vs enemy: local const inv keeps this an if/else.
              if (U.team[j] === teami) {
                // Separation applies to friends only, so enemy ranks can close.
                const inv = 1 / Math.sqrt(dd);
                sx += (dx * inv) * (SEP_RADIUS * inv);
                sy += (dy * inv) * (SEP_RADIUS * inv);
                friendClose++;
                U.state[j] === ROUTING && routNear++;
              } else {
                enemyClose++;
                dd < ceD2 && (ceD2 = dd, ceIdx = j);
              }
            }
          }
          j = next[j];
        }
      }
    }

    // --- combat: active units strike the nearest enemy in reach ---------------
    let engaged = false;
    if (statei === ACTIVE && ceIdx !== -1 && ceD2 <= attackR2) {
      const tt = U.type[ceIdx];
      // Attacking downhill (higher ground than the target) hits harder.
      const dh = T.elevation[tcell] - T.elevation[T.cellOf(U.x[ceIdx], U.y[ceIdx])];
      const bonus = clamp(1 + dh * HEIGHT_DMG, 0.5, 1.6);
      // Per-type dps, the rock-paper-scissors matchup, and the target's armor.
      let hit = TYPE_MELEE_DPS[typei] * dt * bonus * DMG_MULT[typei][tt] * (1 - TYPE_ARMOR[tt]);
      // Cavalry charge: a ready knight moving fast into contact delivers a burst
      // plus morale shock — unless the target is a braced pike, which negates it
      // (this is what makes pike beat cavalry). Then it goes on cooldown.
      (typei === KNIGHT && tt !== PIKE && U.cooldown[i] <= 0 &&
        mag(U.vx[i], U.vy[i]) >= CHARGE_MIN_SPEED) &&
        (hit *= CHARGE_DMG, U.morale[ceIdx] -= CHARGE_MORALE, U.cooldown[i] = CHARGE_COOLDOWN);
      dmg[ceIdx] += hit;
      engaged = true;
    }

    // --- morale (everything except damage-fear, which needs the final dmg) ----
    let m = U.morale[i];
    const net = enemyClose - friendClose;
    enemyClose > 0
      ? (net > 0 && (m -= FEAR_OUTNUMBERED * dt * Math.min(net, 6)))
      : (m += MORALE_REGEN * dt);
    routNear > 0 && (m -= FEAR_PANIC * dt * Math.min(routNear, 6));
    U.morale[i] = m; // clamped in the apply pass

    // --- movement: resolve one move desire, then a single shared steer block ---
    // Every state moves relative to one point: a routing unit flees the nearest
    // enemy, an engaged unit presses it, everyone else marches to their rally.
    // `sign` picks seek (+1, toward) or flee (-1, away); a routing unit that
    // senses no enemy has no target and just coasts — damping bleeds off its
    // speed while separation still applies. The rally is the squad's spawn
    // objective, or wherever the player last commanded the selection it belongs
    // to; enemies met on the way flip it into the engage branch above.
    let ax = 0, ay = 0;
    let tx = 0, ty = 0, sign = 1, seek = true;
    if (statei === ROUTING) {
      seek = ceIdx !== -1;
      seek && (tx = U.x[ceIdx], ty = U.y[ceIdx], sign = -1);
    } else if (engaged) {
      tx = U.x[ceIdx]; ty = U.y[ceIdx];
    } else {
      tx = U.rallyX[i]; ty = U.rallyY[i];
    }
    // Unit vector to (or from) the target × SEEK_ACCEL; left at zero when there
    // is no target or the unit is already sitting on the point.
    if (seek) {
      const dx = (tx - xi) * sign;
      const dy = (ty - yi) * sign;
      const d = mag(dx, dy);
      d > 0.001 && (ax = (dx / d) * SEEK_ACCEL, ay = (dy / d) * SEEK_ACCEL);
    }
    ax += sx * SEP_ACCEL;
    ay += sy * SEP_ACCEL;

    // Shoreline avoidance: steer back if open water lies just ahead.
    const curSp = mag(U.vx[i], U.vy[i]);
    if (curSp > 1) {
      const inv = 1 / curSp;
      const hx = U.vx[i] * inv;
      const hy = U.vy[i] * inv;
      T.isWaterAt(xi + hx * WATER_LOOK, yi + hy * WATER_LOOK) &&
        (ax -= hx * WATER_AVOID, ay -= hy * WATER_AVOID);
    }

    let nvx = (U.vx[i] + ax * dt) * DAMPING;
    let nvy = (U.vy[i] + ay * dt) * DAMPING;
    // Clamp the raw steering velocity to a global ceiling so a packed separation
    // burst can't fling anyone; per-type pace is applied to travel below.
    let sp = mag(nvx, nvy);
    sp > MAX_STEER_SPEED && (nvx *= MAX_STEER_SPEED / sp, nvy *= MAX_STEER_SPEED / sp, sp = MAX_STEER_SPEED);
    U.vx[i] = nvx;
    U.vy[i] = nvy;

    // Per-type march pace: a direct multiplier on how far this velocity carries
    // the unit, so cavalry cover ground faster than infantry. Routing units flee
    // quicker still.
    const pace = TYPE_SPEED_MULT[typei] * (statei === ROUTING ? FLEE_SPEED_MULT : 1);

    // Terrain speed factor: brush slows; uphill slows, downhill speeds up.
    let tf = 1 - T.cover[tcell] * COVER_SLOW;
    if (sp > 0.001) {
      const gx = T.elevation[tcy * T.cols + clampIndex(tcx + 1, T.cols)] - T.elevation[tcy * T.cols + clampIndex(tcx - 1, T.cols)];
      const gy = T.elevation[clampIndex(tcy + 1, T.rows) * T.cols + tcx] - T.elevation[clampIndex(tcy - 1, T.rows) * T.cols + tcx];
      const slopeAlong = (gx * nvx + gy * nvy) / sp; // >0 = uphill
      tf -= slopeAlong * SLOPE_SPEED;
    }
    tf = clamp(tf, 0.35, 1.35);

    let nx = xi + nvx * tf * pace * dt;
    let ny = yi + nvy * tf * pace * dt;

    // Water is impassable: try to slide along the shore, else hold position.
    T.isWaterAt(nx, ny) && (
      !T.isWaterAt(nx, yi) ? (ny = yi, U.vy[i] = 0)
        : !T.isWaterAt(xi, ny) ? (nx = xi, U.vx[i] = 0)
        : (nx = xi, ny = yi, U.vx[i] = 0, U.vy[i] = 0)
    );

    U.x[i] = clamp(nx, 0, W - 1);
    U.y[i] = clamp(ny, 0, H - 1);
  }

  // Volleys: loose ready archers at their beaten zones, land due arrows into dmg.
  Archery.step(archery, count, tick, dmg);

  resolveDamage(count);
  U.compactDead();
};

// Mark a unit dead and log where it fell for the renderer.
const kill = (i) => {
  U.state[i] = DEAD;
  deaths.n < MAX_UNITS && (deaths.x[deaths.n] = U.x[i], deaths.y[deaths.n] = U.y[i], deaths.n++);
};

// --- apply accumulated damage, then resolve morale-driven state transitions ---
const resolveDamage = (count) => {
  for (let i = 0; i < count; i++) {
    const d = dmg[i];
    d > 0 && (U.hp[i] -= d, U.morale[i] -= d * HIT_FEAR, dmg[i] = 0);
    const m = clamp(U.morale[i], 0, MORALE_MAX);
    U.morale[i] = m;

    U.hp[i] <= 0
      ? kill(i)
      : U.state[i] === ROUTING
        ? (m >= RALLY_THRESHOLD && (U.state[i] = ACTIVE))
        : m <= ROUT_THRESHOLD && (U.state[i] = ROUTING);
  }
};
