// Balance harness — plain node, no browser, no build (docs/unit-rework-plan.md
// §9). The sim is DOM-free and package.json is type:module, so this imports
// src/sim directly and runs battles far faster than realtime. This is how the
// combat numbers get tuned instead of eyeballing 5000 dots.
//
//   npm run balance            standard mixed battles across seeds
//   npm run balance:matrix     every archetype squad vs every other, equal
//                              cost: each side spends the same points budget
//                              on its one archetype, so a knight column is a
//                              quarter the heads of the levy mob it faces —
//                              verdicts compare surviving *value* (heads ×
//                              cost), the only fair score across costs
//
// Flags: --seeds=N --ticks=N --budget=N (matrix points per side). --defend flips
// the matrix from both sides colliding at the map center to the first-named
// archetype holding its spawn ground while the other marches onto it — ranged
// matchups are positional since the longbow stand-still rule (a marching
// longbow line never fires; a planted one shoots the whole approach), so the
// two modes give different, equally real verdicts.

import * as world from '../src/sim/world.js';
import * as U from '../src/sim/units.js';
import * as Rally from '../src/sim/rally.js';
import { TICK_S, ARCHETYPES, ARCH_COUNT, ARCH_COST, ARMY_BUDGET, WORLD_W, WORLD_H } from '../src/config.js';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : dflt;
};
const MATRIX = process.argv.includes('--matrix');
const DEFEND = process.argv.includes('--defend');
const SEEDS = arg('seeds', 5);
const TICKS = arg('ticks', 6000);   // × TICK_S ≈ 3 sim-minutes
const BUDGET = arg('budget', 2000); // matrix mode: army points per side

const names = ARCHETYPES.map((a) => a.name);
const onehot = (a) => ARCHETYPES.map((_, i) => (i === a ? 1 : 0));

// Survivors by [team][archetype] after a run.
const survivors = () => {
  const s = [new Array(ARCH_COUNT).fill(0), new Array(ARCH_COUNT).fill(0)];
  for (let i = 0; i < U.count; i++) s[U.team[i]][U.arch[i]]++;
  return s;
};

const centroid = (team) => {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < U.count; i++)
    if (U.team[i] === team) { sx += U.x[i]; sy += U.y[i]; n++; }
  return [sx / n, sy / n];
};

// Run one battle. In matrix mode every rally flag is re-pointed at one spot so
// the matchup always happens instead of squads marching to scattered
// objectives on opposite halves: the map center (both sides collide), or with
// `target` a team index, that team's spawn centroid — the defenders plant on
// the ground they already hold and the attackers march onto it.
const run = (seed, armies, target) => {
  world.init(seed, armies);
  if (target !== null) {
    const [tx, ty] = target === 'center' ? [WORLD_W / 2, WORLD_H / 2] : centroid(target);
    Rally.getRallies().forEach((r) => Rally.move(r.id, tx, ty));
  }
  for (let t = 0; t < TICKS; t++) world.step(TICK_S);
  return survivors();
};

const t0 = Date.now();
let ticksRun = 0;

if (MATRIX) {
  console.log(`matrix${DEFEND ? ' (first named defends its ground)' : ''}: ` +
    `${BUDGET} points a side, ${TICKS} ticks, ${SEEDS} seeds × both sides\n`);
  for (let a = 0; a < ARCH_COUNT; a++) {
    for (let b = DEFEND ? 0 : a + 1; b < ARCH_COUNT; b++) {
      if (a === b) continue;
      // Each seed runs the pair in both deployments so the left/right terrain
      // draw washes out of the verdict. In defend mode `a` is always the side
      // holding its ground (the pairing is no longer symmetric, so both orders
      // of every pair run).
      let sa = 0, sb = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s1 = run(seed, { mix0: onehot(a), mix1: onehot(b), budget: BUDGET }, DEFEND ? 0 : 'center');
        sa += s1[0][a]; sb += s1[1][b];
        const s2 = run(seed, { mix0: onehot(b), mix1: onehot(a), budget: BUDGET }, DEFEND ? 1 : 'center');
        sa += s2[1][a]; sb += s2[0][b];
        ticksRun += 2 * TICKS;
      }
      // Sides field different head counts, so the verdict weighs survivors by
      // cost: the winner is whoever holds more surviving points of the equal
      // budgets, not more heads. Margins under a few percent are called a draw
      // — in defend mode a melee attacker can spend most of the clock marching,
      // and a verdict off a sliver of two near-intact armies is rounding noise.
      const va = sa * ARCH_COST[a], vb = sb * ARCH_COST[b];
      const fielded = (x) => Math.round(BUDGET / ARCH_COST[x]);
      const verdict = Math.abs(va - vb) * 2 <= 0.03 * (va + vb) ? 'draw'
        : va > vb ? names[a] : names[b];
      console.log(
        `${names[a].padEnd(11)} ×${String(fielded(a)).padEnd(4)} vs ` +
        `${names[b].padEnd(11)} ×${String(fielded(b)).padEnd(4)}  ` +
        `${String(sa).padStart(5)} / ${String(sb).padStart(5)} alive  ` +
        `value ${String(va).padStart(5)} / ${String(vb).padStart(5)}  → ${verdict}`,
      );
    }
  }
} else {
  console.log(`standard battle: ${ARMY_BUDGET} points a side, ${TICKS} ticks, ${SEEDS} seeds\n`);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = run(seed, null, null);
    ticksRun += TICKS;
    const tot = (t) => s[t].reduce((x, y) => x + y, 0);
    const fmt = (t) => s[t].map((n, i) => `${names[i]} ${n}`).join('  ');
    console.log(`seed ${seed}:  silver ${tot(0)}  (${fmt(0)})`);
    console.log(`         red    ${tot(1)}  (${fmt(1)})`);
  }
}

console.log(`\n${(ticksRun / ((Date.now() - t0) / 1000) / 1000).toFixed(1)}k ticks/sec`);
