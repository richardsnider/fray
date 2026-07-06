// Balance harness — plain node, no browser, no build (docs/unit-rework-plan.md
// §9). The sim is DOM-free and package.json is type:module, so this imports
// src/sim directly and runs battles far faster than realtime. This is how the
// combat numbers get tuned instead of eyeballing 5000 dots.
//
//   npm run balance            standard mixed battles across seeds
//   npm run balance:matrix     every archetype squad vs every other, equal
//                              counts (equal cost once archetype costs land)
//
// Flags: --seeds=N --ticks=N --size=N (matrix units per side). --defend flips
// the matrix from both sides colliding at the map center to the first-named
// archetype holding its spawn ground while the other marches onto it — ranged
// matchups are positional since the longbow stand-still rule (a marching
// longbow line never fires; a planted one shoots the whole approach), so the
// two modes give different, equally real verdicts.

import * as world from '../src/sim/world.js';
import * as U from '../src/sim/units.js';
import * as Rally from '../src/sim/rally.js';
import { TICK_S, ARCHETYPES, ARCH_COUNT, ARMY_SIZE, WORLD_W, WORLD_H } from '../src/config.js';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : dflt;
};
const MATRIX = process.argv.includes('--matrix');
const DEFEND = process.argv.includes('--defend');
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
    `${SIZE} vs ${SIZE}, ${TICKS} ticks, ${SEEDS} seeds × both sides\n`);
  for (let a = 0; a < ARCH_COUNT; a++) {
    for (let b = DEFEND ? 0 : a + 1; b < ARCH_COUNT; b++) {
      if (a === b) continue;
      // Each seed runs the pair in both deployments so the left/right terrain
      // draw washes out of the verdict. In defend mode `a` is always the side
      // holding its ground (the pairing is no longer symmetric, so both orders
      // of every pair run).
      let sa = 0, sb = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s1 = run(seed, { mix0: onehot(a), mix1: onehot(b), size: SIZE }, DEFEND ? 0 : 'center');
        sa += s1[0][a]; sb += s1[1][b];
        const s2 = run(seed, { mix0: onehot(b), mix1: onehot(a), size: SIZE }, DEFEND ? 1 : 'center');
        sa += s2[1][a]; sb += s2[0][b];
        ticksRun += 2 * TICKS;
      }
      const n = SEEDS * 2 * SIZE;
      const verdict = sa === sb ? 'draw' : sa > sb ? names[a] : names[b];
      console.log(
        `${names[a].padEnd(11)} vs ${names[b].padEnd(11)}  ` +
        `${String(sa).padStart(5)} / ${String(sb).padStart(5)} of ${n}  → ${verdict}`,
      );
    }
  }
} else {
  console.log(`standard battle: ${ARMY_SIZE} vs ${ARMY_SIZE}, ${TICKS} ticks, ${SEEDS} seeds\n`);
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
