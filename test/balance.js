// Balance harness — plain node, no browser, no build (rework2 plan B §7). The
// sim is DOM-free and package.json is type:module, so this imports src/sim
// directly and runs battles far faster than realtime. This is how the combat
// numbers get tuned instead of eyeballing 5000 dots.
//
//   npm run balance            standard mixed battles across seeds
//   npm run balance:matrix     every archetype squad vs every other at equal
//                              *head count*: N knights fight N levy, and the
//                              verdict is raw survivors. Cost is deliberately
//                              not in the verdict — it's an economy/roster
//                              lever tuned later, on top of per-head matchup
//                              truths established here (a levy player fields
//                              2-3× the heads in a real game; see --ratio)
//   npm run balance:goals      the design's sure-ness list (eval-thoughts,
//                              rework2 plan B §7) as PASS/FAIL assertions —
//                              the regression suite for combat tuning
//
// Flags: --seeds=N --ticks=N --heads=N (heads per side in matrix/goals).
// --ratio=A,B sweeps outnumbering: N of A vs 1×..4× N of B, reporting where
// the numbers overwhelm the per-head advantage — the input for costing.
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
const RATIO = argStr('ratio', null);
const SEEDS = arg('seeds', GOALS ? 3 : 5);
const TICKS = arg('ticks', 6000);   // × TICK_S ≈ 3 sim-minutes
const HEADS = arg('heads', 300);    // matrix/goals: heads per side

const names = ARCHETYPES.map((a) => a.name);
const byName = (n) => {
  const i = names.indexOf(n);
  if (i === -1) throw new Error(`no archetype named "${n}"`);
  return i;
};
// A one-archetype army of n heads. spawnArmy buys budget×mix/cost heads, so a
// mix entry of cost×n against a budget of 1 spawns exactly n — head counts
// stay cost-blind without touching the engine.
const heads = (a, n) => ARCHETYPES.map((_, i) => (i === a ? ARCH_COST[a] * n : 0));

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
const run = (seed, scen, mixes, target, ticks) => {
  world.init(seed, { ...mixes, budget: 1, paint: scen.paint, zones: scen.zones, yband: scen.yband });
  if (target !== null) {
    const [tx, ty] = target === 'center' ? [WORLD_W / 2, WORLD_H / 2]
      : target === 'edge' ? [WORLD_W * scen.zones[0][1], WORLD_H / 2]
      : centroid(target);
    Rally.getRallies().forEach((r) => Rally.move(r.id, tx, ty));
  }
  for (let t = 0; t < ticks; t++) world.step(TICK_S);
  ticksRun += ticks;
  return survivors();
};

// One matchup, na heads of a vs nb heads of b, on a scenario: SEEDS seeds ×
// both deployments so the left/right draw (spawn scatter, split-field sides)
// washes out. `defend` plants a on its spawn ground and marches b onto it.
// Verdict is raw survivors, with margins under a few percent of the combined
// survivors called a draw: in defend mode a melee attacker can spend most of
// the clock marching, and a verdict off a sliver of two near-intact armies is
// rounding noise.
const duel = (a, b, scen, defend, na = HEADS, nb = HEADS, ticks = TICKS) => {
  let sa = 0, sb = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s1 = run(seed, scen, { mix0: heads(a, na), mix1: heads(b, nb) }, defend ? 0 : scen.target ?? 'center', ticks);
    sa += s1[0][a]; sb += s1[1][b];
    const s2 = run(seed, scen, { mix0: heads(b, nb), mix1: heads(a, na) }, defend ? 1 : scen.target ?? 'center', ticks);
    sa += s2[1][a]; sb += s2[0][b];
  }
  const verdict = Math.abs(sa - sb) * 2 <= 0.03 * (sa + sb) ? 'draw'
    : sa > sb ? names[a] : names[b];
  return { sa, sb, verdict };
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
    // (c) longbows king on the open field with distance; heavy horse the best hope.
    // c1 runs a double clock: armored pikes need most of the standard 6000
    // ticks just to cross the far map — the verdict is in the second half.
    { id: 'c1', scen: 'far', a: 'longbowmen', b: 'pikemen', expect: 'a', defend: true, ticks: 12000 },
    { id: 'c2', scen: 'far', a: 'longbowmen', b: 'levy', expect: 'a', defend: true },
    { id: 'c3', scen: 'far', a: 'longbowmen', b: 'knights', expect: 'b', defend: true },
    // (d) ranged spawned next to melee mostly loses (foot ranged; horse
    // archers are excluded — outrunning the blades is their whole design)
    { id: 'd1', scen: 'adjacent', a: 'levy', b: 'longbowmen', expect: 'a' },
    { id: 'd2', scen: 'adjacent', a: 'levy', b: 'skirmishers', expect: 'a' },
    { id: 'd3', scen: 'adjacent', a: 'sergeants', b: 'longbowmen', expect: 'a' },
    { id: 'd4', scen: 'adjacent', a: 'pikemen', b: 'skirmishers', expect: 'a' },
  ];
  console.log(`goals: ${HEADS} heads a side, ${TICKS} ticks, ${SEEDS} seeds × both sides\n`);
  let failed = 0;
  for (const g of goals) {
    const { sa, sb, verdict } = duel(byName(g.a), byName(g.b), SCENARIOS[g.scen], g.defend ?? false, HEADS, HEADS, g.ticks ?? TICKS);
    const margin = ((sa - sb) / ((sa + sb) || 1) * 100).toFixed(0);
    const ok = g.expect === 'report' ? null
      : g.expect === 'a' ? verdict === g.a
      : g.expect === 'b' ? verdict === g.b
      : verdict !== g.b; // notB
    ok === false && failed++;
    console.log(
      `${g.id.padEnd(3)} ${g.scen.padEnd(9)} ${(g.defend ? `${g.a} (defends)` : g.a).padEnd(23)} vs ${g.b.padEnd(12)} ` +
      `alive ${String(sa).padStart(5)} / ${String(sb).padStart(5)}  (${margin > 0 ? '+' : ''}${margin}%)  ` +
      (ok === null ? `→ ${verdict}` : ok ? 'PASS' : `FAIL (${verdict})`),
    );
  }
  console.log(failed ? `\n${failed} goal(s) failing` : '\nall goals pass');
  failed && (process.exitCode = 1);
} else if (MATRIX) {
  console.log(`matrix (${SCENARIO}${DEFEND ? ', first named defends its ground' : ''}): ` +
    `${HEADS} heads a side, ${TICKS} ticks, ${SEEDS} seeds × both sides\n`);
  const scen = SCENARIOS[SCENARIO];
  const only = argStr('only', null);
  only !== null && byName(only); // fail fast on a typo'd archetype name
  for (let a = 0; a < ARCH_COUNT; a++) {
    for (let b = DEFEND ? 0 : a + 1; b < ARCH_COUNT; b++) {
      if (a === b) continue;
      if (only !== null && names[a] !== only && names[b] !== only) continue;
      const { sa, sb, verdict } = duel(a, b, scen, DEFEND);
      console.log(
        `${names[a].padEnd(13)} vs ${names[b].padEnd(13)}  ` +
        `${String(sa).padStart(5)} / ${String(sb).padStart(5)} alive  → ${verdict}`,
      );
    }
  }
} else if (RATIO !== null) {
  // Outnumbering sweep for one pair: HEADS of a hold still per-head quality
  // while b brings 1×..4× the heads. The multiplier where the verdict flips
  // is what a head of a is worth in heads of b — the ground truth for costing
  // a against b in the roster economy (which the sim itself ignores).
  const [a, b] = RATIO.split(',').map((s) => byName(s.trim()));
  const scen = SCENARIOS[SCENARIO];
  console.log(`ratio (${SCENARIO}${DEFEND ? ', first named defends its ground' : ''}): ` +
    `${HEADS} ${names[a]} vs N× ${names[b]}, ${TICKS} ticks, ${SEEDS} seeds × both sides\n`);
  for (const mult of [1, 1.5, 2, 2.5, 3, 4]) {
    const nb = Math.round(HEADS * mult);
    const { sa, sb, verdict } = duel(a, b, scen, DEFEND, HEADS, nb);
    console.log(
      `${names[a]} ×${HEADS} vs ${names[b]} ×${String(nb).padEnd(5)} ` +
      `${String(sa).padStart(5)} / ${String(sb).padStart(5)} alive  → ${verdict}`,
    );
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
