// The deterministic simulation core. Deliberately DOM-free and canvas-free so it
// can later run in a Web Worker or faster-than-realtime for balance testing.

import * as U from './units.js';
import * as T from './terrain.js';
import * as Grid from './spatialGrid.js';
import * as Flow from './flowField.js';
import * as Archery from './archery.js';
import { mulberry32 } from './rng.js';
import { clamp, clampIndex, mag } from '../util/math.js';
import { cellCoord } from '../util/grid2d.js';
import {
  MAX_UNITS, WORLD_W, WORLD_H, ARMY_SIZE, SEEK_ACCEL, SEP_RADIUS, SEP_ACCEL, DAMPING,
  ATTACK_RANGE, FLEE_SPEED_MULT,
  MORALE_MAX, ROUT_THRESHOLD, RALLY_THRESHOLD, MORALE_REGEN,
  FEAR_OUTNUMBERED, FEAR_PANIC, HIT_FEAR,
  SLOPE_SPEED, COVER_SLOW, HEIGHT_DMG, WATER_LOOK, WATER_AVOID,
  FLOW_CELL, FLOW_UPDATE_TICKS,
  UnitType, UNIT_TYPE_COUNT, ARMY_MIX, SQUAD_SIZE, SQUAD_RADIUS,
  TYPE_SPEED, TYPE_MELEE_DPS, TYPE_ARMOR, DMG_MULT,
  CHARGE_MIN_SPEED, CHARGE_DMG, CHARGE_MORALE, CHARGE_COOLDOWN,
} from '../config.js';

const { ACTIVE, ROUTING, DEAD } = U.STATE;
const { KNIGHT, PIKE } = UnitType;

const W = WORLD_W;
const H = WORLD_H;
let grid = null;        // fine grid (SEP_RADIUS) for separation + melee
let archery = null;     // volley aim grid + pending-impact queue (sim/archery.js)

// One flow field per team, routing around water toward that team's objective.
const flows = [null, null];
let tick = 0;
const flowDir = { x: 0, y: 0 }; // reused scratch to avoid per-unit allocation

// Incoming damage is accumulated here during the scan and applied after the full
// pass, so kill resolution doesn't depend on unit iteration order.
const dmg = new Float32Array(MAX_UNITS);

// Per-team objective point. In the slice each team seeks the enemy's center of
// mass, so the armies clash on their own. A player click overrides team 0's.
const targets = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
let manualTarget0 = null;

// Live counts for the HUD, refreshed each tick.
const stats = { team0: 0, team1: 0 };

// Seeded RNG for spawn placement / type rolls; reset in init() so one seed
// reproduces the whole battle. Decorrelated from the terrain seed via XOR.
let rng = Math.random;

export const init = (seed = 0) => {
  rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  T.generate(seed);
  grid = Grid.create(W, H, SEP_RADIUS);
  archery = Archery.create();
  const blocked = (wx, wy) => T.isWaterAt(wx, wy);
  for (let t = 0; t < flows.length; t++) {
    flows[t] = Flow.create(W, H, FLOW_CELL);
    Flow.setBlocked(flows[t], blocked);
  }
  tick = 0;
  manualTarget0 = null;
  deaths.n = 0;
  U.reset();
  spawnArmies();
};

// Called by the input layer, which receives `world` via dependency injection —
// so static analysis can't see the edge (hence the ignore).
// fallow-ignore-next-line unused-export
export const setManualTarget = (x, y) => { manualTarget0 = { x, y }; };

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
const spawnSquad = (x0, x1, y0, y1, team, type, n) => {
  const r = SQUAD_RADIUS;
  const cx = rand(Math.min(x0 + r, x1), Math.max(x1 - r, x0));
  const cy = rand(Math.min(y0 + r, y1), Math.max(y1 - r, y0));
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
    U.spawn(x, y, team, type);
  }
};

const rand = (a, b) => a + rng() * (b - a);

const updateTargets = () => {
  // Centroid per team → default objective is "advance on the enemy mass".
  // Routing units are excluded so a formation doesn't chase its own fleers.
  let x0 = 0, y0 = 0, n0 = 0;
  let x1 = 0, y1 = 0, n1 = 0;
  let a0 = 0, a1 = 0;
  for (let i = 0; i < U.count; i++) {
    const active = U.state[i] === ACTIVE;
    U.team[i] === 0
      ? (a0++, active && (x0 += U.x[i], y0 += U.y[i], n0++))
      : (a1++, active && (x1 += U.x[i], y1 += U.y[i], n1++));
  }
  n1 && (targets[0].x = x1 / n1, targets[0].y = y1 / n1);
  n0 && (targets[1].x = x0 / n0, targets[1].y = y0 / n0);
  manualTarget0 && (targets[0].x = manualTarget0.x, targets[0].y = manualTarget0.y);
  stats.team0 = a0;
  stats.team1 = a1;
};

export const step = (dt) => {
  const count = U.count;

  // Snapshot current positions as "previous" for render interpolation.
  U.px.set(U.x.subarray(0, count));
  U.py.set(U.y.subarray(0, count));

  updateTargets();

  // Rebuild each team's flow field toward its objective, a few times a second.
  tick % FLOW_UPDATE_TICKS === 0 && (
    Flow.compute(flows[0], targets[0].x, targets[0].y),
    Flow.compute(flows[1], targets[1].x, targets[1].y)
  );
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

    // --- movement (per-branch vector math with local consts stays if/else) ----
    let ax, ay;
    if (statei === ROUTING) {
      // Flee directly away from the nearest enemy; if none is sensed, keep going.
      if (ceIdx !== -1) {
        ax = xi - U.x[ceIdx];
        ay = yi - U.y[ceIdx];
        const d = mag(ax, ay) || 1;
        ax = (ax / d) * SEEK_ACCEL;
        ay = (ay / d) * SEEK_ACCEL;
      } else {
        ax = 0; ay = 0;
      }
    } else if (engaged) {
      // Press the attack: lean into the closest enemy.
      ax = U.x[ceIdx] - xi;
      ay = U.y[ceIdx] - yi;
      const d = mag(ax, ay) || 1;
      ax = (ax / d) * SEEK_ACCEL;
      ay = (ay / d) * SEEK_ACCEL;
    } else {
      // March toward the objective, following the team flow field so the path
      // routes around water. Near the goal (or unreachable cells) the field
      // reads zero, so fall back to steering straight at the objective point.
      Flow.sampleDir(flows[teami], xi, yi, flowDir);
      if (flowDir.x !== 0 || flowDir.y !== 0) {
        ax = flowDir.x * SEEK_ACCEL;
        ay = flowDir.y * SEEK_ACCEL;
      } else {
        const t = targets[teami];
        ax = t.x - xi;
        ay = t.y - yi;
        const d = mag(ax, ay);
        d > 0.001 && (ax = (ax / d) * SEEK_ACCEL, ay = (ay / d) * SEEK_ACCEL);
      }
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
    const baseSp = TYPE_SPEED[typei];
    const maxSp = statei === ROUTING ? baseSp * FLEE_SPEED_MULT : baseSp;
    let sp = mag(nvx, nvy);
    sp > maxSp && (nvx *= maxSp / sp, nvy *= maxSp / sp, sp = maxSp);
    U.vx[i] = nvx;
    U.vy[i] = nvy;

    // Terrain speed factor: brush slows; uphill slows, downhill speeds up.
    let tf = 1 - T.cover[tcell] * COVER_SLOW;
    if (sp > 0.001) {
      const gx = T.elevation[tcy * T.cols + clampIndex(tcx + 1, T.cols)] - T.elevation[tcy * T.cols + clampIndex(tcx - 1, T.cols)];
      const gy = T.elevation[clampIndex(tcy + 1, T.rows) * T.cols + tcx] - T.elevation[clampIndex(tcy - 1, T.rows) * T.cols + tcx];
      const slopeAlong = (gx * nvx + gy * nvy) / sp; // >0 = uphill
      tf -= slopeAlong * SLOPE_SPEED;
    }
    tf = clamp(tf, 0.35, 1.35);

    let nx = xi + nvx * tf * dt;
    let ny = yi + nvy * tf * dt;

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
