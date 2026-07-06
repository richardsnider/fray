// Massed archery as area fire, not per-unit sniping. Each ready archer volleys
// at the densest enemy cell of a coarse aim grid within bow range (the "beaten
// zone"); the arrows land ARROW_FLIGHT seconds later on whoever is standing in
// that cell — friend or foe — with the damage split across the cell's occupants.
// No per-arrow entities: firing pushes (cell, land-tick) onto a ring buffer,
// landing folds the queued damage into the world's dmg accumulator. Cost is
// O(archers + units) per tick, replacing the per-archer neighbor-list scans, and
// misses are real: units that leave the zone during the flight walk out from
// under the volley.
//
// Aiming is deliberately dumb — pure enemy density, friendly fire included. A
// hold-fire heuristic (penalize cells holding friends) is a one-line score
// tweak, reserved for the AI director so battlefield judgement lives in one
// place.
//
// State is plain data from create(); step() advances it one sim tick.

import * as U from './units.js';
import * as T from './terrain.js';
import { cellCoord, cellIndexOf } from '../util/grid2d.js';
import {
  MAX_UNITS, WORLD_W, WORLD_H, TICK_S, Arch, Weapon, ARCH_WEAPON,
  ARCH_DMG_REDUCE, DMG_MULT, ARROW_COVER,
  ARCHER_RANGE, ARCHER_RELOAD, ARCHER_SHOT_DMG, ARCHER_RESCAN,
  AIM_CELL, ARROW_FLIGHT,
} from '../config.js';

// Phase-1 gate: only longbow-armed units volley. Rework phase 3 parametrizes
// range/reload/damage per bow class and adds BOW (shortbows fire on the move).
const LONGBOW = Weapon.LONGBOW;
const LONGBOW_DMG_MULT = DMG_MULT[Arch.LONGBOWMEN]; // interim RPS row, dies in phase 2
const ACTIVE = U.STATE.ACTIVE;

// Exported for the renderer, which draws in-flight volleys off the ring buffer.
export const FLIGHT_TICKS = Math.max(1, Math.round(ARROW_FLIGHT / TICK_S));

export const create = () => {
  const cols = Math.ceil(WORLD_W / AIM_CELL);
  const rows = Math.ceil(WORLD_H / AIM_CELL);
  const n = cols * rows;
  return {
    cols, rows,
    counts: [new Uint16Array(n), new Uint16Array(n)], // per-team occupants per cell
    landing: new Float32Array(n),                     // damage landing this tick
    // Pending-impact ring buffer. RELOAD > FLIGHT keeps each archer to at most
    // one volley in the air, so MAX_UNITS entries can never overflow. Launch
    // points (qX0/qY0) are render-only: the sim resolves impacts by cell.
    qCell: new Int32Array(MAX_UNITS),
    qTick: new Int32Array(MAX_UNITS),
    qX0: new Float32Array(MAX_UNITS),
    qY0: new Float32Array(MAX_UNITS),
    qHead: 0,
    qTail: 0,
    dirty: false, // landing[] has residue from the previous tick
  };
};

// One archery tick: refresh occupancy counts, loose ready volleys, land due ones.
export const step = (a, count, tick, dmg) => {
  buildCounts(a, count);
  fire(a, count, tick);
  land(a, count, tick, dmg);
};

const buildCounts = (a, count) => {
  const { cols, rows, counts } = a;
  counts[0].fill(0);
  counts[1].fill(0);
  for (let i = 0; i < count; i++)
    counts[U.team[i]][cellIndexOf(U.x[i], U.y[i], AIM_CELL, cols, rows)]++;
};

const fire = (a, count, tick) => {
  const { cols, rows, counts } = a;
  const range2 = ARCHER_RANGE * ARCHER_RANGE;
  const reach = Math.ceil(ARCHER_RANGE / AIM_CELL);
  for (let i = 0; i < count; i++) {
    if (ARCH_WEAPON[U.arch[i]] !== LONGBOW || U.state[i] !== ACTIVE || U.cooldown[i] > 0) continue;
    const xi = U.x[i];
    const yi = U.y[i];
    const enemy = counts[1 - U.team[i]];
    const cx = cellCoord(xi, AIM_CELL, cols);
    const cy = cellCoord(yi, AIM_CELL, rows);
    const x0 = Math.max(cx - reach, 0), x1 = Math.min(cx + reach, cols - 1);
    const y0 = Math.max(cy - reach, 0), y1 = Math.min(cy + reach, rows - 1);
    // Beaten zone = densest enemy cell whose center is in range; nearest wins ties.
    let best = -1, bestN = 0, bestD2 = Infinity;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const c = gy * cols + gx;
        const e = enemy[c];
        if (e === 0) continue;
        const dx = (gx + 0.5) * AIM_CELL - xi;
        const dy = (gy + 0.5) * AIM_CELL - yi;
        const d2 = dx * dx + dy * dy;
        (d2 <= range2 && (e > bestN || (e === bestN && d2 < bestD2))) &&
          (best = c, bestN = e, bestD2 = d2);
      }
    }
    if (best === -1) { U.cooldown[i] = ARCHER_RESCAN; continue; }
    a.qCell[a.qTail] = best;
    a.qTick[a.qTail] = tick + FLIGHT_TICKS;
    a.qX0[a.qTail] = xi;
    a.qY0[a.qTail] = yi;
    a.qTail = (a.qTail + 1) % MAX_UNITS;
    U.cooldown[i] = ARCHER_RELOAD;
  }
};

// Pop every volley due this tick into landing[], then spread each hit cell's
// damage over its current occupants (empty cell = the volley wasted). Per-victim
// reductions (armor, RPS matchup, brush cover) apply on impact.
const land = (a, count, tick, dmg) => {
  const { cols, rows, counts, landing } = a;
  a.dirty && (landing.fill(0), a.dirty = false);
  let any = false;
  while (a.qHead !== a.qTail && a.qTick[a.qHead] <= tick) {
    landing[a.qCell[a.qHead]] += ARCHER_SHOT_DMG;
    a.qHead = (a.qHead + 1) % MAX_UNITS;
    any = true;
  }
  if (!any) return;
  a.dirty = true;
  const c0 = counts[0], c1 = counts[1];
  for (let i = 0; i < count; i++) {
    const c = cellIndexOf(U.x[i], U.y[i], AIM_CELL, cols, rows);
    const d = landing[c];
    if (d === 0) continue;
    const tt = U.arch[i];
    const cover = T.cover[T.cellOf(U.x[i], U.y[i])];
    dmg[i] += (d / (c0[c] + c1[c])) * LONGBOW_DMG_MULT[tt] * (1 - ARCH_DMG_REDUCE[tt]) * (1 - cover * ARROW_COVER);
  }
};
