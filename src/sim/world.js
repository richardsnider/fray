// The deterministic simulation core. Deliberately DOM-free and canvas-free so it
// can later run in a Web Worker or faster-than-realtime for balance testing.

import * as U from './units.js';
import * as T from './terrain.js';
import * as Grid from './spatialGrid.js';
import * as Archery from './archery.js';
import * as Rally from './rally.js';
import * as Formation from './formation.js';
import * as Command from './command.js';
import { mulberry32 } from './rng.js';
import { clamp, clamp01, clampIndex, mag } from '../util/math.js';
import { cellCoord } from '../util/grid2d.js';
import {
  MAX_UNITS, WORLD_W, WORLD_H, ARMY_BUDGET, SEEK_ACCEL, SEP_RADIUS, SEP_ACCEL, DAMPING,
  MAX_STEER_SPEED, FLEE_SPEED_MULT,
  MORALE_MAX, ROUT_THRESHOLD, RALLY_THRESHOLD, MORALE_REGEN,
  FEAR_OUTNUMBERED, FEAR_PANIC, HIT_FEAR,
  SLOPE_SPEED, BRUSH_SPEED_CAP, MUD_SLOW, HEIGHT_DMG, WATER_LOOK, WATER_AVOID,
  POLEARM_BRUSH,
  ARCH_COUNT, ARCH_COST, ARMY_MIX, SQUAD_SIZE, SQUAD_RADIUS, REFORM_TICKS,
  ARCH_SPEED, ARCH_ARMOR, ARCH_WEAPON, ARCH_MOUNTED, ARCH_MELEE_DPS, ARCH_MOUNT_MELEE, Weapon,
  WEAPON_RANGE, WEAPON_DPS, WEAPON_VS_ARMOR,
  POLEARM_BAND, STANDOFF_FRAC, IMPALE_MULT,
  LONGBOW_STILL, LANCE_SPEED_MULT,
} from '../config.js';

const { ACTIVE, ROUTING, DEAD } = U.STATE;
const POLEARM = Weapon.POLEARM;
const LONGBOW = Weapon.LONGBOW;
const LANCE = Weapon.LANCE;

// Per-weapon derived tables, computed once at load. Bows never melee (dps 0),
// so their long volley range widens nothing here. The scan ring is how many
// spatial-grid cells the closest-enemy search must walk to see the weapon's
// reach — 1 (the 3×3 separation walk) for everything but polearm's reach 11.
const MELEE_R2 = WEAPON_RANGE.map((r, w) => (WEAPON_DPS[w] > 0 ? r * r : 0));
const STANDOFF2 = WEAPON_RANGE.map((r, w) => (w === POLEARM ? (r * STANDOFF_FRAC) ** 2 : 0));
const BAND_MIN2 = (WEAPON_RANGE[POLEARM] * POLEARM_BAND) ** 2; // polearm damage-band floor²
const ENEMY_R2 = MELEE_R2.map((r2) => Math.max(r2, SEP_RADIUS * SEP_RADIUS));
const SCAN_RING = ENEMY_R2.map((r2) => Math.ceil(Math.sqrt(r2) / SEP_RADIUS));

const W = WORLD_W;
const H = WORLD_H;
let grid = null;        // fine grid (SEP_RADIUS) for separation + melee
let archery = null;     // volley aim grid + pending-impact queue (sim/archery.js)

let tick = 0;

// Incoming damage is accumulated here during the scan and applied after the full
// pass, so kill resolution doesn't depend on unit iteration order.
const dmg = new Float32Array(MAX_UNITS);

// Player control lives in sim/command.js (selection + orders), which repoints
// the rally flags in sim/rally.js; the sim's job here is just to march every
// unit to its flag each tick.

// Live counts for the HUD, refreshed each tick.
const stats = { team0: 0, team1: 0 };

// Seeded RNG for spawn placement / type rolls; reset in init() so one seed
// reproduces the whole battle. Decorrelated from the terrain seed via XOR.
let rng = Math.random;

// `armies` (optional, used by the balance harness) overrides the deployment:
// { mix0, mix1, budget, zones, yband, paint } — per-archetype budget shares
// of either side, army points per side, spawn zones as [[x0,x1],[x0,x1]]
// fractions of world width (yband likewise of height, shared by both sides),
// and a synthetic-terrain paint fn (terrain.js).
export const init = (seed = 0, armies = null) => {
  rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  T.generate(seed, armies?.paint ?? null);
  grid = Grid.create(W, H, SEP_RADIUS);
  archery = Archery.create();
  tick = 0;
  deaths.n = 0;
  Rally.reset();
  Command.reset();
  U.reset();
  spawnArmies(armies);
  Formation.reassignAll(); // deal every squad its opening rank-and-file slots
};

export const getStats = () => stats;

// Read-only views for the renderer: in-flight volleys come straight off the
// archery ring buffer, and the tick anchors their flight interpolation.
export const getArchery = () => archery;
export const getTick = () => tick;

// Death log for the renderer (blood decals): positions of units killed since
// the consumer last reset `n`. Write-only for the sim — determinism unaffected.
export const deaths = { x: new Float32Array(MAX_UNITS), y: new Float32Array(MAX_UNITS), n: 0 };

const spawnArmies = (armies) => {
  const budget = armies?.budget ?? ARMY_BUDGET;
  const z = armies?.zones;
  const yb = armies?.yband ?? [0.2, 0.8];
  spawnArmy(W * (z?.[0][0] ?? 0.06), W * (z?.[0][1] ?? 0.24), H * yb[0], H * yb[1], 0, armies?.mix0 ?? ARMY_MIX, budget);
  spawnArmy(W * (z?.[1][0] ?? 0.76), W * (z?.[1][1] ?? 0.94), H * yb[0], H * yb[1], 1, armies?.mix1 ?? ARMY_MIX, budget);
};

// Deploy an army into its zone [x0,x1] x [y0,y1] as clustered single-archetype
// squads, so each archetype reads as a coherent group instead of an intermixed
// soup. Each archetype's share of the points budget buys as many heads as its
// cost affords (rounding wobbles the spend by at most half a unit's cost per
// line — noise against a squad).
const spawnArmy = (x0, x1, y0, y1, team, mix, budget) => {
  for (let t = 0; t < ARCH_COUNT; t++) {
    const count = Math.round(budget * mix[t] / ARCH_COST[t]);
    for (let n = count; n > 0; n -= SQUAD_SIZE) {
      spawnSquad(x0, x1, y0, y1, team, t, Math.min(SQUAD_SIZE, n));
    }
  }
};

// Scatter n units of one archetype in a disk around a random deploy point. The center
// is kept a radius inside the zone so the squad stays within its army's area.
// Each squad also gets its own rally point somewhere on the enemy's half of the
// field, so squads fan out toward scattered objectives and the battle breaks
// into several fronts instead of collapsing into one central mob.
const spawnSquad = (x0, x1, y0, y1, team, arch, n) => {
  const r = SQUAD_RADIUS;
  const cx = rand(Math.min(x0 + r, x1), Math.max(x1 - r, x0));
  const cy = rand(Math.min(y0 + r, y1), Math.max(y1 - r, y0));
  // Rally on the far side: team 0 (deploys left) heads right, team 1 vice-versa.
  const rx = team === 0 ? rand(W * 0.55, W * 0.92) : rand(W * 0.08, W * 0.45);
  const ry = rand(H * 0.1, H * 0.9);
  // Record it for the flag overlay, tagged with a short per-team code name.
  const rid = Rally.mint(rx, ry, team);
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
    U.spawn(x, y, team, arch, rid);
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

  // Re-deal formation slots on a slow cadence so ranks close over casualty
  // gaps and slot deals track drifting squads; commands re-deal immediately
  // (sim/command.js).
  tick % REFORM_TICKS === 0 && Formation.reassignAll();

  Grid.build(grid, count, U.x, U.y, U.team);

  const { cell, cols, rows, heads, next, teamCounts } = grid;
  const scanR2 = SEP_RADIUS * SEP_RADIUS;   // separation / awareness radius
  const stillD2 = (LONGBOW_STILL * dt) ** 2; // travel² under which a longbow counts as standing
  // Full-gallop travel per tick before pace: the equilibrium of the steering
  // recurrence v ← (v + SEEK_ACCEL·dt)·DAMPING, carried over one tick on flat
  // open ground (tf = 1). × ARCH_SPEED it normalizes the lance's speedFrac.
  const gallop = SEEK_ACCEL * dt * dt * (DAMPING / (1 - DAMPING));

  for (let i = 0; i < count; i++) {
    const xi = U.x[i];
    const yi = U.y[i];
    const teami = U.team[i];
    const statei = U.state[i];
    const archi = U.arch[i];
    const weapi = ARCH_WEAPON[archi];
    // This unit's terrain cell, shared by the combat height bonus and the
    // movement cover/slope factors below.
    const tcx = cellCoord(xi, T.CELL, T.cols);
    const tcy = cellCoord(yi, T.CELL, T.rows);
    const tcell = tcy * T.cols + tcx;

    // --- neighbor scan: separation (friends), plus enemy/friend awareness -----
    // Separation and the morale counts keep today's SEP_RADIUS; only the
    // closest-enemy search accepts out to the weapon's melee reach, which
    // widens the cell walk past 3×3 solely for polearms (reach 11 > cell 6).
    let sx = 0, sy = 0;
    let friendClose = 0;
    let enemyClose = 0;
    let routNear = 0;
    let ceIdx = -1;         // closest enemy (within ENEMY_R2 of this weapon)
    let ceD2 = Infinity;
    let beIdx = -1;         // polearms only: closest enemy at/beyond the band
    let beD2 = Infinity;    // floor — the strike target when ceIdx is inside it
    const isPole = weapi === POLEARM;

    const ring = SCAN_RING[weapi];
    const enemyR2 = ENEMY_R2[weapi];
    const foeCount = teamCounts[1 - teami];
    const cx = cellCoord(xi, cell, cols);
    const cy = cellCoord(yi, cell, rows);
    for (let oy = -ring; oy <= ring; oy++) {
      const gy = cy + oy;
      if (gy < 0 || gy >= rows) continue;
      for (let ox = -ring; ox <= ring; ox++) {
        const gx = cx + ox;
        if (gx < 0 || gx >= cols) continue;
        const gc = gy * cols + gx;
        // Cells beyond the 3×3 core exist only for the closest-enemy search:
        // in the grid's start-of-tick snapshot, anything within SEP_RADIUS 6
        // sits inside the core at cell size 6. So an enemy-empty outer cell
        // has nothing to offer — skip it without walking its occupants. This
        // is what keeps a *marching* pike block — 25 cells of friends — at
        // ring-1 cost. (A friend that moved close *this* tick can still be
        // listed in an outer cell; skipping it matches the ring-1 walk every
        // other weapon gets, which never saw such friends either.)
        if (ring > 1 && (ox < -1 || ox > 1 || oy < -1 || oy > 1) && foeCount[gc] === 0) continue;
        let j = heads[gc];
        while (j !== -1) {
          if (j !== i) {
            const dx = xi - U.x[j];
            const dy = yi - U.y[j];
            const dd = dx * dx + dy * dy;
            if (dd < enemyR2 && dd > 0.0001) {
              // friend vs enemy: local const inv keeps this an if/else.
              if (U.team[j] === teami) {
                if (dd < scanR2) {
                  // Separation applies to friends only, so enemy ranks can close.
                  const inv = 1 / Math.sqrt(dd);
                  sx += (dx * inv) * (SEP_RADIUS * inv);
                  sy += (dy * inv) * (SEP_RADIUS * inv);
                  friendClose++;
                  U.state[j] === ROUTING && routNear++;
                }
              } else {
                dd < scanR2 && enemyClose++;
                dd < ceD2 && (ceD2 = dd, ceIdx = j);
                isPole && dd < beD2 && dd >= BAND_MIN2 && (beD2 = dd, beIdx = j);
              }
            }
          }
          j = next[j];
        }
      }
    }

    // An enemy inside the awareness radius pins this unit for archery: you
    // can't work a bow with a blade on you (sim/archery.js reads the flag).
    U.pressed[i] = ceIdx !== -1 && ceD2 < scanR2 ? 1 : 0;

    // --- combat: active units strike the nearest enemy in weapon reach --------
    // Continuous dps × dt into the accumulator, single-target — which is what
    // makes flanking emergent: three attackers pour in 3× and eat 1× back.
    // Damage = weapon rate × the weapon-vs-armor matrix × the height bonus ×
    // the polearm rules: a hard damage band (full rate between POLEARM_BAND
    // and max reach, zero inside — a blade that burrows past the points faces
    // harmless pikes, while rank 2 fights over rank 1's shoulder) times the
    // impalement rule (the victim's closing speed onto the point, squared —
    // the lance rule in reverse; a galloping horse impales itself, a standing
    // knight is an ordinary target) cut by the wielder's brush cover (no room
    // to work a 16-foot shaft in trees). Bows have melee dps 0 and never
    // engage (MELEE_R2 = 0); their fight is sim/archery.js.
    let engaged = false;
    let lanceDmg = 0;   // a lance strike waits on this tick's travel, applied below
    let lanceIdx = -1;
    if (statei === ACTIVE && ceIdx !== -1 && ceD2 <= MELEE_R2[weapi]) {
      engaged = true; // even a pike with the enemy inside its points is fighting, not resting
      // A polearm never wastes its thrust on the enemy burrowed inside its
      // points: it strikes the nearest enemy at/beyond the band floor instead
      // (eval-thoughts #1's no-targeting-below-the-band) — you can't spear
      // the man on your chest, so you spear the next one a shaft-length out.
      // Without this, anything fast enough to penetrate the standoff (any
      // cavalry) shut a whole pike block's damage off by standing inside it.
      const ti = !isPole ? ceIdx : beD2 <= MELEE_R2[weapi] ? beIdx : -1;
      const tD2 = isPole ? beD2 : ceD2;
      if (ti !== -1) {
        // Attacking downhill (higher ground than the target) hits harder.
        const dh = T.elevation[tcell] - T.elevation[T.cellOf(U.x[ti], U.y[ti])];
        const bonus = clamp(1 + dh * HEIGHT_DMG, 0.5, 1.6);
        const ta = U.arch[ti];
        let prof = 1;
        if (isPole) {
          // Impalement: the victim's actual travel last movement tick (tvx/tvy,
          // real displacement after terrain and clamps), projected onto the
          // line toward this wielder, normalized by the *unmounted* full-march
          // travel — so closingFrac ~1 is infantry pressing in at a walk and
          // ~1.26–1.8 is horse arriving at canter/gallop, no mount check on
          // the victim. The *wielder* must be on foot: setting a point against
          // a charge takes planted feet and ground behind the butt — this is
          // the can't-brace-on-a-horse rule. A rider's spear keeps its reach
          // and thrust rate but never earns the charge spike.
          let imp = 0;
          if (!ARCH_MOUNTED[archi]) {
            const inv = 1 / Math.sqrt(tD2);
            const closing = (U.tvx[ti] * (xi - U.x[ti]) + U.tvy[ti] * (yi - U.y[ti])) * inv / gallop;
            closing > 0 && (imp = IMPALE_MULT * closing * closing);
          }
          prof = (1 + imp) * (1 - T.cover[tcell] * POLEARM_BRUSH);
        }
        // The saddle bonus (mounted blade/blunt, config ARCH_MOUNT_MELEE) is
        // open-ground work — striking down needs room to ride past and room
        // to swing, so it fades with the *square* of the rider's brush cover
        // (both are gone in a thicket, where a horseman hacks among branches
        // like anyone else). The lance scales with the striker's travel,
        // known only after the movement below — park its base rate for the
        // late add; dmg[] resolves after the full pass, so a late accumulate
        // changes nothing else.
        const open = 1 - T.cover[tcell];
        const d = ARCH_MELEE_DPS[archi] * (1 + ARCH_MOUNT_MELEE[archi] * open * open)
          * dt * bonus * prof * WEAPON_VS_ARMOR[weapi][ARCH_ARMOR[ta]];
        weapi === LANCE ? (lanceDmg = d, lanceIdx = ti) : (dmg[ti] += d);
      }
    }

    // --- morale (everything except damage-fear, which needs the final dmg) ----
    // The counts keep SEP_RADIUS semantics; `engaged` additionally blocks the
    // regen so a polearm fighting at reach (enemy beyond the awareness radius
    // but inside its 11-unit reach) doesn't recover morale mid-fight.
    let m = U.morale[i];
    const net = enemyClose - friendClose;
    enemyClose > 0
      ? (net > 0 && (m -= FEAR_OUTNUMBERED * dt * Math.min(net, 6)))
      : engaged || (m += MORALE_REGEN * dt);
    routNear > 0 && (m -= FEAR_PANIC * dt * Math.min(routNear, 6));
    U.morale[i] = m; // clamped in the apply pass

    // --- movement: resolve one move desire, then a single shared steer block ---
    // Every state moves relative to one point: a routing unit flees the nearest
    // enemy, an engaged unit presses it (down to its weapon's standoff),
    // everyone else marches to their rally.
    // `sign` picks seek (+1, toward) or flee (-1, away); a routing unit that
    // senses no enemy has no target and just coasts — damping bleeds off its
    // speed while separation still applies. The rally is resolved through the
    // unit's flag (rallyId → position, the single source of truth): the squad's
    // spawn objective, or wherever the player last commanded the selection it
    // belongs to — refined to the unit's own formation slot when the flag has
    // dealt ranks (sim/formation.js), so squads form up instead of balling on
    // the point. Enemies met on the way flip it into the engage branch above.
    let ax = 0, ay = 0;
    let tx = 0, ty = 0, sign = 1, seek = true;
    if (statei === ROUTING) {
      seek = ceIdx !== -1;
      seek && (tx = U.x[ceIdx], ty = U.y[ceIdx], sign = -1);
    } else if (engaged) {
      // Press the enemy only while beyond the weapon's standoff: blades and
      // lances run to contact (standoff 0), polearms hold at reach — so
      // blades naturally burrow into pike ranks where the points are blunt.
      seek = ceD2 > STANDOFF2[weapi];
      seek && (tx = U.x[ceIdx], ty = U.y[ceIdx]);
    } else {
      // Every live unit's rallyId resolves (squads mint a flag at spawn and
      // pruning only drops followerless flags); the guard just makes a stray
      // id coast like a target-less router instead of marching to (0,0).
      const ral = Rally.byId(U.rallyId[i]);
      seek = ral !== undefined;
      seek && (ral.cols > 0
        ? (tx = Formation.slotX(ral, U.slot[i]), ty = Formation.slotY(ral, U.slot[i]))
        : (tx = ral.x, ty = ral.y));
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

    // Per-archetype march pace: a direct multiplier on how far this velocity
    // carries the unit, so cavalry cover ground faster than infantry. Routing
    // units flee quicker still.
    const pace = ARCH_SPEED[archi] * (statei === ROUTING ? FLEE_SPEED_MULT : 1);

    // Terrain speed factor: mud slows proportionally (soft ground drags every
    // leg); uphill slows, downhill speeds up.
    let tf = T.mudAt(xi, yi) ? 1 - MUD_SLOW : 1;
    if (sp > 0.001) {
      const gx = T.elevation[tcy * T.cols + clampIndex(tcx + 1, T.cols)] - T.elevation[tcy * T.cols + clampIndex(tcx - 1, T.cols)];
      const gy = T.elevation[clampIndex(tcy + 1, T.rows) * T.cols + tcx] - T.elevation[clampIndex(tcy - 1, T.rows) * T.cols + tcx];
      const slopeAlong = (gx * nvx + gy * nvy) / sp; // >0 = uphill
      tf -= slopeAlong * SLOPE_SPEED;
    }
    tf = clamp(tf, 0.35, 1.35);

    // Brush is a hard ceiling on ground speed, not a multiplier: travel is
    // capped at BRUSH_SPEED_CAP / cover density, so open ground never binds,
    // a walking man barely notices light scrub, and in a thicket every
    // archetype converges on the same crawl — a mount's pace (and a router's
    // flee bonus) die with the room to run. This is what makes brush cavalry
    // country's end without any mount-specific rule.
    let mult = tf * pace;
    const cov = T.cover[tcell];
    if (cov > 0.01) {
      const trav = sp * mult;
      const cap = BRUSH_SPEED_CAP / cov;
      trav > cap && (mult = cap / sp);
    }

    let nx = xi + nvx * mult * dt;
    let ny = yi + nvy * mult * dt;

    // Water is impassable: try to slide along the shore, else hold position.
    T.isWaterAt(nx, ny) && (
      !T.isWaterAt(nx, yi) ? (ny = yi, U.vy[i] = 0)
        : !T.isWaterAt(xi, ny) ? (nx = xi, U.vx[i] = 0)
        : (nx = xi, ny = yi, U.vx[i] = 0, U.vy[i] = 0)
    );

    U.x[i] = clamp(nx, 0, W - 1);
    U.y[i] = clamp(ny, 0, H - 1);

    // Actual travel this tick — the real displacement after terrain, pace and
    // clamps. Stored per unit: the impalement rule reads a *victim's* travel
    // (units later in this pass see this tick's, earlier ones last tick's —
    // both are "current speed" at tick scale, and it stays deterministic).
    const tvx = U.x[i] - xi, tvy = U.y[i] - yi;
    U.tvx[i] = tvx;
    U.tvy[i] = tvy;

    // --- lance: the parked strike, scaled by this tick's actual travel --------
    // speedFrac normalizes the real displacement (terrain, pace, water clamps
    // and all) by this unit's own full gallop: 0 standing … 1 at open-field
    // charge. The scale is *quadratic* in speed — impact energy goes as v² —
    // so the short sprints of a melee kill-chain (each dead pikeman opens a
    // few units to the next, briefly re-arming the lance) score little, and
    // only a real run-up pays in full. Contact at gallop is a self-limiting
    // burst: the press bleeds the speed within a few ticks, milling in a
    // melee scores near the naked standing rate.
    if (lanceDmg > 0) {
      const frac = clamp01((tvx * tvx + tvy * tvy) / (gallop * ARCH_SPEED[archi]) ** 2);
      dmg[lanceIdx] += lanceDmg * (1 + frac * LANCE_SPEED_MULT);
    }

    // --- reload & the longbow set clock (sim/archery.js fires at cooldown 0) --
    // Cooldown ticks down for everyone. A longbow additionally keeps a
    // stillness clock, zeroed by any real movement this tick; archery only
    // looses it once the clock passes LONGBOW_SET — the line must stand and
    // set before it can shoot, so repositioning is a real commitment (rework2
    // plan B §3). Shortbows volley on the move. Runs after the position writes
    // because it needs the tick's actual travel.
    weapi === LONGBOW &&
      (U.still[i] = tvx * tvx + tvy * tvy > stillD2 ? 0 : U.still[i] + dt);
    U.cooldown[i] > 0 && (U.cooldown[i] -= dt);
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
