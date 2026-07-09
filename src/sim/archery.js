// Massed archery as area fire, not per-unit sniping. Each ready archer volleys
// at the densest enemy cell of a coarse aim grid within bow range (the "beaten
// zone"); the arrows land ARROW_FLIGHT seconds later on whoever is standing in
// that cell — friend or foe — with the damage split across the cell's occupants.
// Both bow classes fire this way; the class picks range/reload/damage and how
// arrows meet armor. What silences a bow (rework2 plan B §3): an enemy at
// arm's length (the pressed flag, set by world.js's neighbor scan), a beaten
// zone nearer than the class minimum range, and — longbows only — a stillness
// clock that hasn't reached LONGBOW_SET (world.js zeroes it on movement).
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
  MAX_UNITS, WORLD_W, WORLD_H, TICK_S, Weapon, ARCH_BOW_CLASS, ARCH_ARMOR,
  ARCH_ARROW_MULT, WEAPON_RANGE, WEAPON_VS_ARMOR, ARROW_COVER,
  VOLLEY_DMG, VOLLEY_RELOAD, BOW_MIN_RANGE, BowClass, LONGBOW_SET, ARCHER_RESCAN,
  AIM_CELL, ARROW_FLIGHT,
} from '../config.js';

const ACTIVE = U.STATE.ACTIVE;
const LONGBOW_CLASS = BowClass.LONGBOW;

// Per-class derived tables, indexed by BowClass (BOW 0, LONGBOW 1). Which
// units volley at all is ARCH_BOW_CLASS.
const CLASS_WEAPON = [Weapon.BOW, Weapon.LONGBOW];
const RANGE2 = CLASS_WEAPON.map((w) => WEAPON_RANGE[w] ** 2);
const MIN2 = BOW_MIN_RANGE.map((r) => r * r);
const REACH = CLASS_WEAPON.map((w) => Math.ceil(WEAPON_RANGE[w] / AIM_CELL));
// Impact multiplier per victim archetype: weapon-vs-armor × the mount arrow
// vulnerability (unbarded horses die to massed arrows; barded knights shrug).
const IMPACT = CLASS_WEAPON.map((w) =>
  ARCH_ARROW_MULT.map((m, arch) => WEAPON_VS_ARMOR[w][ARCH_ARMOR[arch]] * m));

// Exported for the renderer, which draws in-flight volleys off the ring buffer.
export const FLIGHT_TICKS = Math.max(1, Math.round(ARROW_FLIGHT / TICK_S));

export const create = () => {
  const cols = Math.ceil(WORLD_W / AIM_CELL);
  const rows = Math.ceil(WORLD_H / AIM_CELL);
  const n = cols * rows;
  return {
    cols, rows,
    counts: [new Uint16Array(n), new Uint16Array(n)], // per-team occupants per cell
    landing: [new Float32Array(n), new Float32Array(n)], // damage landing this tick, per bow class
    // Pending-impact ring buffer. RELOAD > FLIGHT keeps each archer to at most
    // one volley in the air, so MAX_UNITS entries can never overflow. Launch
    // points (qX0/qY0) are render-only: the sim resolves impacts by cell.
    // qDmg is the volley's damage with the shooter-side cover already paid;
    // qClass keys the per-victim impact table at landing.
    qCell: new Int32Array(MAX_UNITS),
    qTick: new Int32Array(MAX_UNITS),
    qX0: new Float32Array(MAX_UNITS),
    qY0: new Float32Array(MAX_UNITS),
    qDmg: new Float32Array(MAX_UNITS),
    qClass: new Uint8Array(MAX_UNITS),
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
  for (let i = 0; i < count; i++) {
    const k = ARCH_BOW_CLASS[U.arch[i]];
    if (k === -1 || U.state[i] !== ACTIVE || U.cooldown[i] > 0) continue;
    // Pressed (an enemy at arm's length) silences either class; a longbow
    // additionally may not loose until it has stood LONGBOW_SET seconds.
    if (U.pressed[i] || (k === LONGBOW_CLASS && U.still[i] < LONGBOW_SET)) continue;
    const range2 = RANGE2[k];
    const min2 = MIN2[k];
    const reach = REACH[k];
    const xi = U.x[i];
    const yi = U.y[i];
    const enemy = counts[1 - U.team[i]];
    const cx = cellCoord(xi, AIM_CELL, cols);
    const cy = cellCoord(yi, AIM_CELL, rows);
    const x0 = Math.max(cx - reach, 0), x1 = Math.min(cx + reach, cols - 1);
    const y0 = Math.max(cy - reach, 0), y1 = Math.min(cy + reach, rows - 1);
    // Beaten zone = densest enemy cell whose center is in range but not
    // inside the class minimum — no dropping arrows at your own feet;
    // nearest wins ties.
    let best = -1, bestN = 0, bestD2 = Infinity;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const c = gy * cols + gx;
        const e = enemy[c];
        if (e === 0) continue;
        const dx = (gx + 0.5) * AIM_CELL - xi;
        const dy = (gy + 0.5) * AIM_CELL - yi;
        const d2 = dx * dx + dy * dy;
        (d2 <= range2 && d2 >= min2 && (e > bestN || (e === bestN && d2 < bestD2))) &&
          (best = c, bestN = e, bestD2 = d2);
      }
    }
    if (best === -1) { U.cooldown[i] = ARCHER_RESCAN; continue; }
    // Shooter-side cover: arrows loosed out of brush lose power at launch,
    // mirroring the victim-side cover reduction at impact — same grid, read
    // both ways.
    const cover = T.cover[T.cellOf(xi, yi)];
    a.qCell[a.qTail] = best;
    a.qTick[a.qTail] = tick + FLIGHT_TICKS;
    a.qX0[a.qTail] = xi;
    a.qY0[a.qTail] = yi;
    a.qDmg[a.qTail] = VOLLEY_DMG[k] * (1 - cover * ARROW_COVER);
    a.qClass[a.qTail] = k;
    a.qTail = (a.qTail + 1) % MAX_UNITS;
    U.cooldown[i] = VOLLEY_RELOAD[k];
  }
};

// Pop every volley due this tick into landing[] (kept per bow class, since the
// two classes bite armor differently), then spread each hit cell's damage over
// its current occupants (empty cell = the volley wasted). Per-victim reductions
// (the weapon-vs-armor matrix, the mount vulnerability, brush cover) apply on
// impact.
const land = (a, count, tick, dmg) => {
  const { cols, rows, counts, landing } = a;
  a.dirty && (landing[0].fill(0), landing[1].fill(0), a.dirty = false);
  let any = false;
  while (a.qHead !== a.qTail && a.qTick[a.qHead] <= tick) {
    landing[a.qClass[a.qHead]][a.qCell[a.qHead]] += a.qDmg[a.qHead];
    a.qHead = (a.qHead + 1) % MAX_UNITS;
    any = true;
  }
  if (!any) return;
  a.dirty = true;
  const c0 = counts[0], c1 = counts[1];
  const l0 = landing[0], l1 = landing[1];
  for (let i = 0; i < count; i++) {
    const c = cellIndexOf(U.x[i], U.y[i], AIM_CELL, cols, rows);
    const d0 = l0[c], d1 = l1[c];
    if (d0 === 0 && d1 === 0) continue;
    const arch = U.arch[i];
    const cover = T.cover[T.cellOf(U.x[i], U.y[i])];
    dmg[i] += ((d0 * IMPACT[0][arch] + d1 * IMPACT[1][arch]) / (c0[c] + c1[c])) * (1 - cover * ARROW_COVER);
  }
};
