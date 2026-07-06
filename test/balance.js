// Balance harness — plain node, no browser, no build (docs/unit-rework-plan.md
// §9). The sim is DOM-free and package.json is type:module, so this imports
// src/sim directly and runs battles far faster than realtime. This is how the
// combat numbers get tuned instead of eyeballing 5000 dots.
//
//   npm run balance            standard mixed battles across seeds
//   npm run balance:matrix     every archetype squad vs every other, equal
//                              counts (equal cost once archetype costs land)
//
// Flags: --seeds=N --ticks=N --size=N (matrix units per side)

import * as world from '../src/sim/world.js';
import * as U from '../src/sim/units.js';
import * as Rally from '../src/sim/rally.js';
import { TICK_S, ARCHETYPES, ARCH_COUNT, ARMY_SIZE, WORLD_W, WORLD_H } from '../src/config.js';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : dflt;
};
const MATRIX = process.argv.includes('--matrix');
const SEEDS = arg('seeds', 5);
const TICKS = arg('ticks', 6000);  // × TICK_S ≈ 3 sim-minutes
const SIZE = arg('size', 500);     // matrix mode: one squad per side

const names = ARCHETYPES.map((a) => a.name);
const onehot = (a) => ARCHETYPES.map((_, i) => (i === a ? 1 : 0));

// Survivors by [team][archetype] after a run.
const survivors = () => {
  const s = [new Array(ARCH_COUNT).fill(0), new Array(ARCH_COUNT).fill(0)];
  for (let i = 0; i < U.count; i++) s[U.team[i]][U.arch[i]]++;
  return s;
};

// Run one battle. In matrix mode both squads' rally flags are re-pointed at
// the map center so the matchup always collides instead of marching to
// scattered objectives on opposite halves.
const run = (seed, armies, collide) => {
  world.init(seed, armies);
  collide && Rally.getRallies().forEach((r) => Rally.move(r.id, WORLD_W / 2, WORLD_H / 2));
  for (let t = 0; t < TICKS; t++) world.step(TICK_S);
  return survivors();
};

const t0 = Date.now();
let ticksRun = 0;

if (MATRIX) {
  console.log(`matrix: ${SIZE} vs ${SIZE}, ${TICKS} ticks, ${SEEDS} seeds × both sides\n`);
  for (let a = 0; a < ARCH_COUNT; a++) {
    for (let b = a + 1; b < ARCH_COUNT; b++) {
      // Each seed runs the pair in both deployments so the left/right terrain
      // draw washes out of the verdict.
      let sa = 0, sb = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s1 = run(seed, { mix0: onehot(a), mix1: onehot(b), size: SIZE }, true);
        sa += s1[0][a]; sb += s1[1][b];
        const s2 = run(seed, { mix0: onehot(b), mix1: onehot(a), size: SIZE }, true);
        sa += s2[1][a]; sb += s2[0][b];
        ticksRun += 2 * TICKS;
      }
      const n = SEEDS * 2 * SIZE;
      const verdict = sa === sb ? 'draw' : sa > sb ? names[a] : names[b];
      console.log(
        `${names[a].padEnd(10)} vs ${names[b].padEnd(10)}  ` +
        `${String(sa).padStart(5)} / ${String(sb).padStart(5)} of ${n}  → ${verdict}`,
      );
    }
  }
} else {
  console.log(`standard battle: ${ARMY_SIZE} vs ${ARMY_SIZE}, ${TICKS} ticks, ${SEEDS} seeds\n`);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = run(seed, null, false);
    ticksRun += TICKS;
    const tot = (t) => s[t].reduce((x, y) => x + y, 0);
    const fmt = (t) => s[t].map((n, i) => `${names[i]} ${n}`).join('  ');
    console.log(`seed ${seed}:  silver ${tot(0)}  (${fmt(0)})`);
    console.log(`         red    ${tot(1)}  (${fmt(1)})`);
  }
}

console.log(`\n${(ticksRun / ((Date.now() - t0) / 1000) / 1000).toFixed(1)}k ticks/sec`);
