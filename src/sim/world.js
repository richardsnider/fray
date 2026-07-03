// The deterministic simulation core. Deliberately DOM-free and canvas-free so it
// can later run in a Web Worker or faster-than-realtime for balance testing.

import * as U from './units.js';
import * as T from './terrain.js';
import { SpatialGrid } from './spatialGrid.js';
import { FlowField } from './flowField.js';
import { mulberry32 } from './rng.js';
import {
  MAX_UNITS, WORLD_W, WORLD_H, ARMY_SIZE, SEEK_ACCEL, SEP_RADIUS, SEP_ACCEL, DAMPING,
  ATTACK_RANGE, FLEE_SPEED_MULT,
  MORALE_MAX, ROUT_THRESHOLD, RALLY_THRESHOLD, MORALE_REGEN,
  FEAR_OUTNUMBERED, FEAR_PANIC, HIT_FEAR,
  SLOPE_SPEED, COVER_SLOW, HEIGHT_DMG, WATER_LOOK, WATER_AVOID,
  FLOW_CELL, FLOW_UPDATE_TICKS,
  UnitType, ARMY_MIX, TYPE_SPEED, TYPE_MELEE_DPS, TYPE_ARMOR, DMG_MULT,
  ARCHER_RANGE, ARCHER_RELOAD, ARCHER_SHOT_DMG, ARROW_COVER,
  CHARGE_MIN_SPEED, CHARGE_DMG, CHARGE_MORALE, CHARGE_COOLDOWN,
} from '../config.js';

const { ACTIVE, ROUTING, DEAD } = U.STATE;
const { KNIGHT, ARCHER, PIKE } = UnitType;

const W = WORLD_W;
const H = WORLD_H;
let grid = null;        // fine grid (SEP_RADIUS) for separation + melee
let rangedGrid = null;  // coarse grid (ARCHER_RANGE) for bow targeting

// One flow field per team, routing around water toward that team's objective.
const flows = [null, null];
let flowTick = 0;
const flowDir = { x: 0, y: 0 }; // reused scratch to avoid per-unit allocation

// Incoming damage is accumulated here during the scan and applied after the full
// pass, so kill resolution doesn't depend on unit iteration order.
const dmg = new Float32Array(MAX_UNITS);

// Per-team objective point. In the slice each team seeks the enemy's center of
// mass, so the armies clash on their own. A player click overrides team 0's.
const targets = [ { x: 0, y: 0 }, { x: 0, y: 0 } ];
let manualTarget0 = null;

// Live counts for the HUD, refreshed each tick.
const stats = { team0: 0, team1: 0 };

// Seeded RNG for spawn placement / type rolls; reset in init() so one seed
// reproduces the whole battle. Decorrelated from the terrain seed via XOR.
let rng = Math.random;

export function init(seed = 0) {
  rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  T.generate(seed);
  grid = new SpatialGrid(W, H, SEP_RADIUS);
  // Bow range dwarfs the melee cell, so archers target off a coarser grid whose
  // cell == range: a 3x3 walk then guarantees every enemy in range is visited.
  rangedGrid = new SpatialGrid(W, H, ARCHER_RANGE);
  const blocked = (wx, wy) => T.isWaterAt(wx, wy);
  for (let t = 0; t < flows.length; t++) {
    flows[t] = new FlowField(W, H, FLOW_CELL);
    flows[t].setBlocked(blocked);
  }
  flowTick = 0;
  manualTarget0 = null;
  U.reset();
  spawnArmies();
}

export function setManualTarget(x, y) {
  manualTarget0 = { x, y };
}

export function getStats() {
  return stats;
}

function spawnArmies() {
  spawnArmy(W * 0.06, W * 0.24, 0);
  spawnArmy(W * 0.76, W * 0.94, 1);
}

function spawnArmy(x0, x1, team) {
  for (let i = 0; i < ARMY_SIZE; i++) {
    let x, y, tries = 0;
    // Reject spots that landed in water so nobody spawns stranded.
    do {
      x = rand(x0, x1);
      y = rand(H * 0.2, H * 0.8);
    } while (T.isWaterAt(x, y) && ++tries < 20);
    U.spawn(x, y, team, pickType());
  }
}

// Draw a unit type from the army composition weights.
function pickType() {
  const r = rng();
  let acc = 0;
  for (let t = 0; t < ARMY_MIX.length; t++) {
    acc += ARMY_MIX[t];
    if (r < acc) return t;
  }
  return ARMY_MIX.length - 1;
}

function rand(a, b) {
  return a + rng() * (b - a);
}

function updateTargets() {
  // Centroid per team → default objective is "advance on the enemy mass".
  // Routing units are excluded so a formation doesn't chase its own fleers.
  let x0 = 0, y0 = 0, n0 = 0;
  let x1 = 0, y1 = 0, n1 = 0;
  let a0 = 0, a1 = 0;
  for (let i = 0; i < U.count; i++) {
    if (U.team[i] === 0) {
      a0++;
      if (U.state[i] === ACTIVE) { x0 += U.x[i]; y0 += U.y[i]; n0++; }
    } else {
      a1++;
      if (U.state[i] === ACTIVE) { x1 += U.x[i]; y1 += U.y[i]; n1++; }
    }
  }
  if (n1) { targets[0].x = x1 / n1; targets[0].y = y1 / n1; }
  if (n0) { targets[1].x = x0 / n0; targets[1].y = y0 / n0; }
  if (manualTarget0) { targets[0].x = manualTarget0.x; targets[0].y = manualTarget0.y; }
  stats.team0 = a0;
  stats.team1 = a1;
}

export function step(dt) {
  const count = U.count;

  // Snapshot current positions as "previous" for render interpolation.
  U.px.set(U.x.subarray(0, count));
  U.py.set(U.y.subarray(0, count));

  updateTargets();

  // Rebuild each team's flow field toward its objective, a few times a second.
  if (flowTick % FLOW_UPDATE_TICKS === 0) {
    flows[0].compute(targets[0].x, targets[0].y);
    flows[1].compute(targets[1].x, targets[1].y);
  }
  flowTick++;

  grid.build(count, U.x, U.y);
  rangedGrid.build(count, U.x, U.y);

  const { cell, cols, rows, heads, next } = grid;
  const scanR2 = SEP_RADIUS * SEP_RADIUS;   // separation / awareness radius
  const attackR2 = ATTACK_RANGE * ATTACK_RANGE;

  for (let i = 0; i < count; i++) {
    const xi = U.x[i];
    const yi = U.y[i];
    const teami = U.team[i];
    const statei = U.state[i];
    const typei = U.type[i];
    if (U.cooldown[i] > 0) U.cooldown[i] -= dt; // archer reload / charge recovery

    // --- neighbor scan: separation (friends), plus enemy/friend awareness -----
    let sx = 0, sy = 0;
    let friendClose = 0;
    let enemyClose = 0;
    let routNear = 0;
    let ceIdx = -1;         // closest enemy
    let ceD2 = Infinity;

    const cx = clampCell((xi / cell) | 0, cols);
    const cy = clampCell((yi / cell) | 0, rows);
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
              if (U.team[j] === teami) {
                // Separation applies to friends only, so enemy ranks can close.
                const inv = 1 / Math.sqrt(dd);
                sx += (dx * inv) * (SEP_RADIUS * inv);
                sy += (dy * inv) * (SEP_RADIUS * inv);
                friendClose++;
                if (U.state[j] === ROUTING) routNear++;
              } else {
                enemyClose++;
                if (dd < ceD2) { ceD2 = dd; ceIdx = j; }
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
      const dh = T.elevation[T.cellOf(xi, yi)] - T.elevation[T.cellOf(U.x[ceIdx], U.y[ceIdx])];
      let bonus = 1 + dh * HEIGHT_DMG;
      if (bonus < 0.5) bonus = 0.5; else if (bonus > 1.6) bonus = 1.6;
      // Per-type dps, the rock-paper-scissors matchup, and the target's armor.
      let hit = TYPE_MELEE_DPS[typei] * dt * bonus * DMG_MULT[typei][tt] * (1 - TYPE_ARMOR[tt]);
      // Cavalry charge: a ready knight moving fast into contact delivers a burst
      // plus morale shock — unless the target is a braced pike, which negates it
      // (this is what makes pike beat cavalry). Then it goes on cooldown.
      if (typei === KNIGHT && tt !== PIKE && U.cooldown[i] <= 0 &&
          Math.hypot(U.vx[i], U.vy[i]) >= CHARGE_MIN_SPEED) {
        hit *= CHARGE_DMG;
        U.morale[ceIdx] -= CHARGE_MORALE; // clamped in the apply pass
        U.cooldown[i] = CHARGE_COOLDOWN;
      }
      dmg[ceIdx] += hit;
      engaged = true;
    }

    // --- morale (everything except damage-fear, which needs the final dmg) ----
    let m = U.morale[i];
    if (enemyClose > 0) {
      const net = enemyClose - friendClose;
      if (net > 0) m -= FEAR_OUTNUMBERED * dt * Math.min(net, 6);
    } else {
      m += MORALE_REGEN * dt;
    }
    if (routNear > 0) m -= FEAR_PANIC * dt * Math.min(routNear, 6);
    U.morale[i] = m; // clamped in the apply pass

    // --- movement -------------------------------------------------------------
    let ax, ay;
    if (statei === ROUTING) {
      // Flee directly away from the nearest enemy; if none is sensed, keep going.
      if (ceIdx !== -1) {
        ax = xi - U.x[ceIdx];
        ay = yi - U.y[ceIdx];
        const d = Math.hypot(ax, ay) || 1;
        ax = (ax / d) * SEEK_ACCEL;
        ay = (ay / d) * SEEK_ACCEL;
      } else {
        ax = 0; ay = 0;
      }
    } else if (engaged) {
      // Press the attack: lean into the closest enemy.
      ax = U.x[ceIdx] - xi;
      ay = U.y[ceIdx] - yi;
      const d = Math.hypot(ax, ay) || 1;
      ax = (ax / d) * SEEK_ACCEL;
      ay = (ay / d) * SEEK_ACCEL;
    } else {
      // March toward the objective, following the team flow field so the path
      // routes around water. Near the goal (or unreachable cells) the field
      // reads zero, so fall back to steering straight at the objective point.
      flows[teami].sampleDir(xi, yi, flowDir);
      if (flowDir.x !== 0 || flowDir.y !== 0) {
        ax = flowDir.x * SEEK_ACCEL;
        ay = flowDir.y * SEEK_ACCEL;
      } else {
        const t = targets[teami];
        ax = t.x - xi;
        ay = t.y - yi;
        const d = Math.hypot(ax, ay);
        if (d > 0.001) { ax = (ax / d) * SEEK_ACCEL; ay = (ay / d) * SEEK_ACCEL; }
      }
    }
    ax += sx * SEP_ACCEL;
    ay += sy * SEP_ACCEL;

    // Shoreline avoidance: steer back if open water lies just ahead.
    const curSp = Math.hypot(U.vx[i], U.vy[i]);
    if (curSp > 1) {
      const inv = 1 / curSp;
      const hx = U.vx[i] * inv;
      const hy = U.vy[i] * inv;
      if (T.isWaterAt(xi + hx * WATER_LOOK, yi + hy * WATER_LOOK)) {
        ax -= hx * WATER_AVOID;
        ay -= hy * WATER_AVOID;
      }
    }

    let nvx = (U.vx[i] + ax * dt) * DAMPING;
    let nvy = (U.vy[i] + ay * dt) * DAMPING;
    const baseSp = TYPE_SPEED[typei];
    const maxSp = statei === ROUTING ? baseSp * FLEE_SPEED_MULT : baseSp;
    let sp = Math.hypot(nvx, nvy);
    if (sp > maxSp) {
      const k = maxSp / sp;
      nvx *= k; nvy *= k;
      sp = maxSp;
    }
    U.vx[i] = nvx;
    U.vy[i] = nvy;

    // Terrain speed factor: brush slows; uphill slows, downhill speeds up.
    let tf = 1 - T.cover[T.cellOf(xi, yi)] * COVER_SLOW;
    if (sp > 0.001) {
      const tcx = tClampX((xi / T.CELL) | 0);
      const tcy = tClampY((yi / T.CELL) | 0);
      const gx = T.elevation[tcy * T.cols + tClampX(tcx + 1)] - T.elevation[tcy * T.cols + tClampX(tcx - 1)];
      const gy = T.elevation[tClampY(tcy + 1) * T.cols + tcx] - T.elevation[tClampY(tcy - 1) * T.cols + tcx];
      const slopeAlong = (gx * nvx + gy * nvy) / sp; // >0 = uphill
      tf -= slopeAlong * SLOPE_SPEED;
    }
    if (tf < 0.35) tf = 0.35; else if (tf > 1.35) tf = 1.35;

    let nx = xi + nvx * tf * dt;
    let ny = yi + nvy * tf * dt;

    // Water is impassable: try to slide along the shore, else hold position.
    if (T.isWaterAt(nx, ny)) {
      if (!T.isWaterAt(nx, yi)) { ny = yi; U.vy[i] = 0; }
      else if (!T.isWaterAt(xi, ny)) { nx = xi; U.vx[i] = 0; }
      else { nx = xi; ny = yi; U.vx[i] = 0; U.vy[i] = 0; }
    }

    if (nx < 0) nx = 0; else if (nx > W - 1) nx = W - 1;
    if (ny < 0) ny = 0; else if (ny > H - 1) ny = H - 1;
    U.x[i] = nx;
    U.y[i] = ny;
  }

  // --- ranged: each ready archer looses one arrow at its nearest enemy --------
  // Reload cadence rate-limits this scan, so only a fraction of archers search
  // per tick. Damage is cut by the target's armor, the RPS matchup, and — the
  // deferred cover mechanic — how much brush the target is standing in.
  {
    const rcell = rangedGrid.cell;
    const rcols = rangedGrid.cols;
    const rrows = rangedGrid.rows;
    const rheads = rangedGrid.heads;
    const rnext = rangedGrid.next;
    const rangeR2 = ARCHER_RANGE * ARCHER_RANGE;
    for (let i = 0; i < count; i++) {
      if (U.type[i] !== ARCHER || U.state[i] !== ACTIVE || U.cooldown[i] > 0) continue;
      const xi = U.x[i];
      const yi = U.y[i];
      const teami = U.team[i];
      let best = -1, bestD2 = rangeR2;
      const cx = clampCell((xi / rcell) | 0, rcols);
      const cy = clampCell((yi / rcell) | 0, rrows);
      for (let oy = -1; oy <= 1; oy++) {
        const gy = cy + oy;
        if (gy < 0 || gy >= rrows) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          if (gx < 0 || gx >= rcols) continue;
          let j = rheads[gy * rcols + gx];
          while (j !== -1) {
            if (U.team[j] !== teami && U.state[j] !== DEAD) {
              const dx = xi - U.x[j];
              const dy = yi - U.y[j];
              const dd = dx * dx + dy * dy;
              if (dd < bestD2) { bestD2 = dd; best = j; }
            }
            j = rnext[j];
          }
        }
      }
      if (best !== -1) {
        const tt = U.type[best];
        const cover = T.cover[T.cellOf(U.x[best], U.y[best])];
        dmg[best] += ARCHER_SHOT_DMG * DMG_MULT[ARCHER][tt] * (1 - TYPE_ARMOR[tt]) * (1 - cover * ARROW_COVER);
        U.cooldown[i] = ARCHER_RELOAD;
      }
    }
  }

  // --- apply damage, resolve morale-driven state transitions ------------------
  for (let i = 0; i < count; i++) {
    const d = dmg[i];
    if (d > 0) {
      U.hp[i] -= d;
      U.morale[i] -= d * HIT_FEAR;
      dmg[i] = 0;
    }
    let m = U.morale[i];
    if (m > MORALE_MAX) m = MORALE_MAX; else if (m < 0) m = 0;
    U.morale[i] = m;

    if (U.hp[i] <= 0) {
      U.state[i] = DEAD;
    } else if (U.state[i] === ROUTING) {
      if (m >= RALLY_THRESHOLD) U.state[i] = ACTIVE;
    } else if (m <= ROUT_THRESHOLD) {
      U.state[i] = ROUTING;
    }
  }

  U.compactDead();
}

function clampCell(c, max) {
  if (c < 0) return 0;
  if (c >= max) return max - 1;
  return c;
}

function tClampX(cx) {
  if (cx < 0) return 0;
  if (cx >= T.cols) return T.cols - 1;
  return cx;
}

function tClampY(cy) {
  if (cy < 0) return 0;
  if (cy >= T.rows) return T.rows - 1;
  return cy;
}
