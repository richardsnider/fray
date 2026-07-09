// Balance harness — plain node, no browser, no build (rework2 plan B §7). The
// sim is DOM-free and package.json is type:module, so this imports src/sim
// directly and runs battles far faster than realtime. This is how the combat
// numbers get tuned instead of eyeballing 5000 dots.
//
//   npm run balance            standard mixed battles across seeds
//   npm run balance:matrix     every archetype squad vs every other, equal
//                              cost: each side spends the same points budget
//                              on its one archetype, so a knight column is a
//                              fraction the heads of the levy mob it faces —
//                              verdicts compare surviving *value* (heads ×
//                              cost), the only fair score across costs
//   npm run balance:goals      the design's sure-ness list (eval-thoughts,
//                              rework2 plan B §7) as PASS/FAIL assertions —
//                              the regression suite for combat tuning
//
// Flags: --seeds=N --ticks=N --budget=N (points per side in matrix/goals).
// --scenario=NAME runs the matrix on a controlled battlefield (see SCENARIOS).
// --only=NAME restricts the matrix to pairs involving one archetype — the
// cheap way to diagnose a single roster line while tuning it.
// --defend flips the matrix from both sides colliding at the map center to
// the first-named archetype holding its spawn ground while the other marches
// onto it — ranged matchups are positional since the longbow set-time rule (a
// marching longbow line never fires; a planted one shoots the whole
// approach), so the two modes give different, equally real verdicts.

import * as world from '../src/sim/world.js';
import * as U from '../src/sim/units.js';
import * as Rally from '../src/sim/rally.js';
import { TICK_S, ARCHETYPES, ARCH_COUNT, ARCH_COST, ARMY_BUDGET, WORLD_W, WORLD_H } from '../src/config.js';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : dflt;
};
const argStr = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const MATRIX = process.argv.includes('--matrix');
const GOALS = process.argv.includes('--goals');
const DEFEND = process.argv.includes('--defend');
const SEEDS = arg('seeds', GOALS ? 3 : 5);
const TICKS = arg('ticks', 6000);   // × TICK_S ≈ 3 sim-minutes
const BUDGET = arg('budget', 2000); // matrix/goals: army points per side

const names = ARCHETYPES.map((a) => a.name);
const byName = (n) => {
  const i = names.indexOf(n);
  if (i === -1) throw new Error(`no archetype named "${n}"`);
  return i;
};
const onehot = (a) => ARCHETYPES.map((_, i) => (i === a ? 1 : 0));

// --- scenarios ---------------------------------------------------------------
// Controlled battlefields (eval-thoughts #4): a paint fn hands terrain.js the
// exact ground (flat field, uniform brush/mud, a split field), zones override
// where the armies spawn (fractions of world width), and target says where
// re-pointed rally flags go. `seeded` is the stock behavior: fbm terrain,
// home zones, collide at the center.
const flat = (over = {}) => () => over;
const leftHalf = (over) => (wx) => (wx < WORLD_W / 2 ? over : {});
const SCENARIOS = {
  seeded:        {},
  open:          { paint: flat() },
  brush:         { paint: flat({ cover: 0.9 }) },
  mud:           { paint: flat({ mud: true }) },
  // Split fields: team 0's half is brush/mud, team 1 fights from the open —
  // the clash happens at the boundary. Run pairs both ways for a fair read.
  'brush-split': { paint: leftHalf({ cover: 0.9 }) },
  'mud-split':   { paint: leftHalf({ mud: true }) },
  // Positional extremes: `far` spawns at the world edges (a long approach
  // under fire), `adjacent` spawns the armies touching and rallies both at
  // the shared edge — no approach at all, ranged gets no stand-off room.
  far:           { paint: flat(), zones: [[0.02, 0.10], [0.90, 0.98]] },
  // Truly touching: two minimum-width strips (squad centers pin to a point
  // 70 world units inside each) and a tight y-band, so the front scatters
  // meet at the shared edge — melee is on the archers before a second volley.
  adjacent:      { paint: flat(), zones: [[0.4555, 0.5], [0.5, 0.5445]], yband: [0.42, 0.58], target: 'edge' },
};
const SCENARIO = argStr('scenario', 'seeded');
if (!SCENARIOS[SCENARIO]) throw new Error(`no scenario "${SCENARIO}" (have: ${Object.keys(SCENARIOS).join(' ')})`);

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

let ticksRun = 0;

// Run one battle on a scenario. With a `target`, every rally flag is
// re-pointed at one spot so the matchup always happens instead of squads
// marching to scattered objectives: 'center' (both sides collide), 'edge'
// (the boundary between the scenario's spawn zones), or a team index — that
// team's spawn centroid, so the defenders plant on the ground they already
// hold and the attackers march onto it.
const run = (seed, scen, mixes, target) => {
  world.init(seed, { ...mixes, budget: BUDGET, paint: scen.paint, zones: scen.zones, yband: scen.yband });
  if (target !== null) {
    const [tx, ty] = target === 'center' ? [WORLD_W / 2, WORLD_H / 2]
      : target === 'edge' ? [WORLD_W * scen.zones[0][1], WORLD_H / 2]
      : centroid(target);
    Rally.getRallies().forEach((r) => Rally.move(r.id, tx, ty));
  }
  for (let t = 0; t < TICKS; t++) world.step(TICK_S);
  ticksRun += TICKS;
  return survivors();
};

// One matchup, a vs b, on a scenario: SEEDS seeds × both deployments so the
// left/right draw (spawn scatter, split-field sides) washes out. `defend`
// plants a on its spawn ground and marches b onto it. Verdict weighs
// survivors by cost — whoever holds more surviving points of the equal
// budgets — with margins under a few percent called a draw: in defend mode a
// melee attacker can spend most of the clock marching, and a verdict off a
// sliver of two near-intact armies is rounding noise.
const duel = (a, b, scen, defend) => {
  let sa = 0, sb = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s1 = run(seed, scen, { mix0: onehot(a), mix1: onehot(b) }, defend ? 0 : scen.target ?? 'center');
    sa += s1[0][a]; sb += s1[1][b];
    const s2 = run(seed, scen, { mix0: onehot(b), mix1: onehot(a) }, defend ? 1 : scen.target ?? 'center');
    sa += s2[1][a]; sb += s2[0][b];
  }
  const va = sa * ARCH_COST[a], vb = sb * ARCH_COST[b];
  const verdict = Math.abs(va - vb) * 2 <= 0.03 * (va + vb) ? 'draw'
    : va > vb ? names[a] : names[b];
  return { sa, sb, va, vb, verdict };
};

const t0 = Date.now();

if (GOALS) {
  // The sure-ness list from eval-thoughts, plus the review's pikemen-vs-blunt
  // goal. expect: 'a' = first archetype must win; 'b' = the *second* must
  // (used where the interesting side defends); 'notB' = a draw is also fine
  // (the goal only rules out b winning); 'report' = print, don't judge.
  // defend: true plants the first archetype on its spawn ground.
  const goals = [
    // (a) outside of brush, pikemen beat cavalry
    { id: 'a1', scen: 'open', a: 'pikemen', b: 'knights', expect: 'a' },
    { id: 'a2', scen: 'open', a: 'pikemen', b: 'light horse', expect: 'a' },
    { id: 'a3', scen: 'brush', a: 'pikemen', b: 'knights', expect: 'report' }, // in brush: experiment
    // (e) pikemen slightly beat equal-armored blunt in the open (watch the margin)
    { id: 'e1', scen: 'open', a: 'pikemen', b: 'sergeants', expect: 'a' },
    // (b) in brush, blade/blunt is king; blade foot ≥ blade cavalry there
    { id: 'b1', scen: 'brush', a: 'levy', b: 'pikemen', expect: 'a' },
    { id: 'b2', scen: 'brush', a: 'levy', b: 'longbowmen', expect: 'a' },
    { id: 'b3', scen: 'brush', a: 'levy', b: 'skirmishers', expect: 'a' },
    { id: 'b4', scen: 'brush', a: 'levy', b: 'light horse', expect: 'notB' },
    // (c) longbows king on the open field with distance; heavy horse the best hope
    { id: 'c1', scen: 'far', a: 'longbowmen', b: 'pikemen', expect: 'a', defend: true },
    { id: 'c2', scen: 'far', a: 'longbowmen', b: 'levy', expect: 'a', defend: true },
    { id: 'c3', scen: 'far', a: 'longbowmen', b: 'knights', expect: 'b', defend: true },
    // (d) ranged spawned next to melee mostly loses (foot ranged; horse
    // archers are excluded — outrunning the blades is their whole design)
    { id: 'd1', scen: 'adjacent', a: 'levy', b: 'longbowmen', expect: 'a' },
    { id: 'd2', scen: 'adjacent', a: 'levy', b: 'skirmishers', expect: 'a' },
    { id: 'd3', scen: 'adjacent', a: 'sergeants', b: 'longbowmen', expect: 'a' },
    { id: 'd4', scen: 'adjacent', a: 'pikemen', b: 'skirmishers', expect: 'a' },
  ];
  console.log(`goals: ${BUDGET} points a side, ${TICKS} ticks, ${SEEDS} seeds × both sides\n`);
  let failed = 0;
  for (const g of goals) {
    const { va, vb, verdict } = duel(byName(g.a), byName(g.b), SCENARIOS[g.scen], g.defend ?? false);
    const margin = ((va - vb) / ((va + vb) || 1) * 100).toFixed(0);
    const ok = g.expect === 'report' ? null
      : g.expect === 'a' ? verdict === g.a
      : g.expect === 'b' ? verdict === g.b
      : verdict !== g.b; // notB
    ok === false && failed++;
    console.log(
      `${g.id.padEnd(3)} ${g.scen.padEnd(9)} ${(g.defend ? `${g.a} (defends)` : g.a).padEnd(23)} vs ${g.b.padEnd(12)} ` +
      `value ${String(va).padStart(5)} / ${String(vb).padStart(5)}  (${margin > 0 ? '+' : ''}${margin}%)  ` +
      (ok === null ? `→ ${verdict}` : ok ? 'PASS' : `FAIL (${verdict})`),
    );
  }
  console.log(failed ? `\n${failed} goal(s) failing` : '\nall goals pass');
  failed && (process.exitCode = 1);
} else if (MATRIX) {
  console.log(`matrix (${SCENARIO}${DEFEND ? ', first named defends its ground' : ''}): ` +
    `${BUDGET} points a side, ${TICKS} ticks, ${SEEDS} seeds × both sides\n`);
  const scen = SCENARIOS[SCENARIO];
  const only = argStr('only', null);
  only !== null && byName(only); // fail fast on a typo'd archetype name
  for (let a = 0; a < ARCH_COUNT; a++) {
    for (let b = DEFEND ? 0 : a + 1; b < ARCH_COUNT; b++) {
      if (a === b) continue;
      if (only !== null && names[a] !== only && names[b] !== only) continue;
      const { sa, sb, va, vb, verdict } = duel(a, b, scen, DEFEND);
      const fielded = (x) => Math.round(BUDGET / ARCH_COST[x]);
      console.log(
        `${names[a].padEnd(13)} ×${String(fielded(a)).padEnd(4)} vs ` +
        `${names[b].padEnd(13)} ×${String(fielded(b)).padEnd(4)}  ` +
        `${String(sa).padStart(5)} / ${String(sb).padStart(5)} alive  ` +
        `value ${String(va).padStart(5)} / ${String(vb).padStart(5)}  → ${verdict}`,
      );
    }
  }
} else {
  console.log(`standard battle: ${ARMY_BUDGET} points a side, ${TICKS} ticks, ${SEEDS} seeds\n`);
  for (let seed = 1; seed <= SEEDS; seed++) {
    world.init(seed);
    for (let t = 0; t < TICKS; t++) world.step(TICK_S);
    ticksRun += TICKS;
    const s = survivors();
    const tot = (t) => s[t].reduce((x, y) => x + y, 0);
    const fmt = (t) => s[t].map((n, i) => `${names[i]} ${n}`).join('  ');
    console.log(`seed ${seed}:  silver ${tot(0)}  (${fmt(0)})`);
    console.log(`         red    ${tot(1)}  (${fmt(1)})`);
  }
}

console.log(`\n${(ticksRun / ((Date.now() - t0) / 1000) / 1000).toFixed(1)}k ticks/sec`);
