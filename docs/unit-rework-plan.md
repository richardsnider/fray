# Plan: unit rework — armor × weapon axes

Status: **draft for discussion** — numbers are starting points, not balance.
Source notes: `todo` (repo root) + README backlog (bow classes vs. armor tiers,
cavalry charges, archer fire discipline).

## Goal

Replace the three hard-coded unit types (knight / archer / pike) and their
single rock-paper-scissors table with two orthogonal axes — **armor tier** and
**weapon class** — plus a **mount** flag. Matchups stop being an authored
type-vs-type matrix and instead fall out of how weapons interact with armor,
distance, movement, and terrain. Flanking, charge run-ups, and formation depth
become emergent rather than scripted.

This is a rework of the combat core, not a patch: melee changes from
continuous DPS to discrete cooldown-gated strikes, and archery splits into two
classes. We accept refactoring `world.js` combat and `archery.js` to get there.

---

## 1. Data model

### Axes

```
Armor  = { NONE: 0, ARMORED: 1, HEAVY: 2 }     // progressively slows the unit
Weapon = { BLADE: 0, BLUNT: 1, POLEARM: 2, BOW: 3, LONGBOW: 4, LANCE: 5 }
mounted = 0 | 1
```

- **Armor** trades speed for protection. Protection lives entirely in the
  weapon-vs-armor matrix (below) — armor does **not** also apply a generic
  damage reduction. One mechanism, no double counting. `TYPE_ARMOR` dies.
- **Weapon** owns damage, strike cooldown, reach, and a distance/movement
  profile. `TYPE_MELEE_DPS` and `DMG_MULT` die.
- **Mount** is a speed multiplier + charge capability + an arrow
  vulnerability. Armor tier covers the whole unit: heavy + mounted *means*
  barded horse (the todo's "heavy armored cavalry implies barding").

### Archetypes

The sim's hot loops shouldn't recombine three axes every read, and the
renderer needs a small bin key. So units carry a single **archetype id** (like
`type` today) and config defines each archetype as a tuple:

```
ARCHETYPES = [
  // name          armor    weapon   mounted   (initial roster)
  { levy      —   NONE,    BLADE,   0 },   // default/basic unit
  { sergeants —   ARMORED, BLUNT,   0 },
  { pikemen   —   ARMORED, POLEARM, 0 },
  { skirmishers — NONE,    BOW,     0 },
  { longbowmen —  NONE,    LONGBOW, 0 },
  { light horse — NONE,    BLADE,   1 },
  { knights   —   HEAVY,   LANCE,   1 },
]
```

At load time config flattens these into per-archetype typed lookup arrays
(`ARCH_ARMOR`, `ARCH_WEAPON`, `ARCH_MOUNTED`, `ARCH_HP`, `ARCH_SPEED`) so hot
loops stay one indexed read, exactly like `TYPE_*` today. The engine supports
the full cross-product; the roster is just data — adding horse archers or
armored longbowmen is one line.

Migration mapping: KNIGHT → knights, ARCHER → longbowmen, PIKE → pikemen.

### SoA changes (`units.js`)

- `type` → `arch` (Uint8, archetype id) — same role, renamed for clarity.
- `cooldown` (exists) — generalizes from "archer reload" to "weapon strike
  cooldown" for every unit.
- **new** `steady` (Float32 or reuse pattern) — seconds stationary, for the
  longbow stand-still rule (see §4). May be derivable from per-tick travel
  instead of stored; decide at implementation.
- **new** `discipline` (Float32, spawn default 1) — per-unit morale scale
  for future squad variants (berserkers etc., see §8). Reserved in phase 1,
  unwired until variants exist.

`spawn` and `copyUnit` pick up the new fields. ~8 bytes/unit added — noise.

---

## 2. Stat tables (config)

All numbers are first-draft targets for parity with today's feel.

```
// Armor tier:                  NONE  ARMORED  HEAVY
ARMOR_SPEED  = [                1.0,   0.85,   0.70 ]   // pace multiplier
ARMOR_HP     = [                 70,    105,    150 ]   // starting hp

MOUNT_SPEED  = 1.8            // pace multiplier when mounted
// heavy + mounted → 1.8 × 0.70 = 1.26: an expensive unit only a little
// faster than unarmored infantry, exactly per the todo.

// Weapon:            BLADE  BLUNT  POLEARM  BOW  LONGBOW  LANCE
WEAPON_RANGE    = [      5,     5,      11,   70,     110,     6 ]
WEAPON_DMG      = [     14,    13,      24,   14,      30,    12 ]  // per strike
WEAPON_COOLDOWN = [    0.8,   0.9,     1.5,  0.9,     1.6,   1.0 ]  // seconds

// Weapon-vs-armor damage multiplier (replaces DMG_MULT):
//                      vs NONE  vs ARMORED  vs HEAVY
WEAPON_VS_ARMOR = [
  /* BLADE   */        [  1.3,      1.0,       0.6  ],
  /* BLUNT   */        [  1.0,      1.1,       1.3  ],
  /* POLEARM */        [  1.0,      1.0,       1.0  ],  // power is in reach, not matchup
  /* BOW     */        [  1.0,      0.55,      0.15 ],  // shortbow: armor shrugs it off
  /* LONGBOW */        [  1.3,      1.0,       0.5  ],  // defeats mail, not plate
  /* LANCE   */        [  1.2,      1.0,       0.9  ],  // × speed bonus, see §3
]

MOUNT_ARROW_MULT = 1.4   // BOW/LONGBOW damage vs mounted units below HEAVY:
                         // unbarded horses die to massed arrows (README backlog)
```

Sanity check vs. today: pike 14 dps continuous → polearm 24 per 1.5 s = 16 dps
*at reach*, near zero adjacent. Knight melee 18 dps → lance 12/strike standing
(weak in a press) but ~48/strike arriving at full gallop. Longbow volley 30
stays.

---

## 3. Melee rework: discrete strikes

Today melee is `dps × dt` every tick against the closest enemy. It becomes:

**Strike loop** (in the existing neighbor scan in `world.js`):
- A unit whose `cooldown ≤ 0` with an enemy inside `WEAPON_RANGE[w]` strikes
  the **closest enemy only** and resets `cooldown = WEAPON_COOLDOWN[w]`.
- One target per strike + a real cooldown is what makes **flanking emergent**
  (the todo's bet): three levies around one sergeant land 3 strikes per cycle
  and eat 1. No facing math, no flanking bonus table.
- Damage per strike:
  `WEAPON_DMG[w] × WEAPON_VS_ARMOR[w][targetArmor] × heightBonus × reachProfile × terrainMods`
  — accumulated into `dmg[]` as today, so resolution stays order-independent.

**Polearm reach profile.** Damage scales with distance to the target:
near-max reach ≈ full damage (the deadliest strike in the game), adjacent ≈
nothing — the todo's "awkwardness" without a special state:

```
reachProfile(POLEARM, d) = lerp(0.05, 1.0, clamp01(d / (0.75 × range)))
reachProfile(other, d)   = 1
```

This makes **formation depth mechanically real**: a knight hugging the front
rank of a pike block is adjacent to rank 1 (harmless to him) but at perfect
reach of rank 2, eight units back. Pike > cavalry survives the death of
`DMG_MULT` — but now it's the *block* that beats cavalry, and a flanked or
scattered pike squad genuinely loses to blades in the press. Nothing new to
code for this; it falls out of the profile + `FORM_SPACING`.

**Standoff distance.** An engaged unit currently presses to contact. A
polearm unit should hold at reach instead: engaged units seek the enemy only
while `d > STANDOFF[w]` (≈ `0.7 × range` for polearm, ~0 for blade/blunt).
Blades then naturally burrow into pike ranks while pikes back-pedal to reach —
the counter-play the todo wants, driven by one comparison in the move-desire
branch.

**Lance — damage scales with current speed. No meter, no stored state.**
The todo's "high dmg when moving," taken literally: a lance strike reads the
striker's **actual per-tick travel** — velocity × terrain factor × pace, the
real displacement, *not* the capped raw steering velocity whose ceiling
killed the old charge mechanic (README backlog) — and scales:

```
speedFrac = travel / maxTravel(unit)          // 0 standing … 1 at full gallop
lanceDmg  = WEAPON_DMG[LANCE] × (1 + speedFrac × LANCE_SPEED_MULT ≈ 3)
```

- The run-up falls out of the movement model for free: from a standstill,
  damping takes on the order of a second of open ground to ease a knight up
  to gallop, so a knight starting adjacent to its target never hits hard,
  while one arriving off a field crossing lands ~48 on contact. Milling in a
  press means near-zero travel and the worst weapon in the game — per the
  todo, lance damage "is still really bad at shorter melee distances like
  infantry."
- **Nothing may slow the approach.** Verified against the current movement
  code: there is no arrival deceleration (seek acceleration is
  constant-magnitude all the way to contact) and separation is friend-only,
  so enemy ranks don't cushion the impact — cavalry already "crashes."
  Guard this: the standoff distance (§3 above) is 0 for lance and blade so
  the engaged press runs through, and any future arrival-easing behavior
  must exempt chargers.
- Cavalry with other weapons (blade light horse now, spear/bow later) simply
  doesn't read the speed scale.

Height bonus, morale, routing, panic contagion: **unchanged**. Melee has no
friendly fire (already true; the todo confirms only ranged carries that risk).

**Scan radius caveat.** The enemy-awareness scan is a 3×3 walk of
`SEP_RADIUS = 6` cells filtered to `d < 6` — polearm reach 11 outranges it.
The fix: keep separation at `SEP_RADIUS`, but let the *enemy* scan accept up
to `max(WEAPON_RANGE[melee])` and widen the cell walk to `ceil(reach / cell)`
(5×5) **only for polearm-armed units**. Costs one extra ring for one archetype;
measure first. If it hurts, the cheap fix is gating the wide walk on the
archery aim grid's per-team density counts (rebuilt every tick anyway): a
polearm unit pays the 5×5 fine scan only when a nearby aim cell actually
holds enemies.

**Why melee stays unit-targeted.** Area targeting is the right model for
arrows — nobody aims at an individual, damage lands on a zone, and
`archery.js` already works exactly this way. It's the wrong model for melee:
a strike needs a victim at reach, and the neighbor walk that finds one is
already paid for by separation — closest-enemy targeting rides along for one
extra compare. A melee "pressure grid" (damage into a cell, split across
occupants) would be cheaper at extreme unit counts, but it erases precisely
what this rework bets on: single-target cooldown strikes are where flanking,
reach profiles, and formation depth come from.

---

## 4. Ranged rework: two bow classes

Both classes keep the **beaten-zone area-fire system** (`archery.js`) — it's
the right model and it's O(archers + units). It gets parametrized per weapon
instead of hard-coding ARCHER:

|                      | BOW (shortbow)            | LONGBOW                        |
|----------------------|---------------------------|--------------------------------|
| range                | ~70                       | 110 (today's)                  |
| reload               | ~0.9 s                    | 1.6 s                          |
| damage/volley        | 14                        | 30                             |
| vs armor             | 1.0 / 0.55 / 0.15         | 1.3 / 1.0 / 0.5                |
| fire on the move     | **yes**                   | **no — see below**             |

**Longbow stand-still rule** ("must stop moving for the entire cooldown"):
the reload cooldown **only ticks down while the unit is stationary** (per-tick
travel below an epsilon). Moving pauses the countdown; the archer must
accumulate a full reload's worth of standing still before the next volley.
One condition on the existing `cooldown -= dt` line. (Alternative — moving
*resets* the countdown — is harsher; proposed: pause, tune later.)

**Shortbows on the move** need no code at all: without the stationary gate
they fire whenever the cooldown lapses, marching or not. Mounted + BOW =
horse archers, free.

**Brush cuts arrows both ways** (todo: "into or out of"): today only the
*victim's* cover reduces damage on impact. Add the shooter's cover at fire
time — scale the queued volley damage by `(1 − shooterCover × ARROW_COVER)`.
Two symmetrical reads of the same grid.

**Mount vulnerability:** on impact, `MOUNT_ARROW_MULT` applies to mounted
victims below HEAVY armor — volleys break a light-horse charge through the
mounts; barded knights shrug (longbows "wouldn't be great against them").

Friendly fire stays exactly as-is: a ranged-only mechanic, and hold-fire
judgement stays reserved for the AI director (README backlog).

---

## 5. Terrain

### Brush / forest (extend existing `cover` grid)

- **Max-speed reduction** — already there (`COVER_SLow` multiplies travel), and
  it already "punishes cavalry" proportionally since it's a multiplier on a
  faster base. No change needed beyond tuning.
- **Ranged damage into/out of** — shooter-side reduction added in §4.
- **Polearm awkwardness in trees** (confirmed: a penalty — longer cooldown
  and/or *lower* damage) — strike cooldown scales up with cover,
  `cooldown × (1 + cover × POLEARM_BRUSH ≈ 0.75)`, optionally damage down,
  `dmg × (1 − cover × k)`. Start with cooldown only: one knob is easier to
  tune, and slower strikes already read as "can't swing a pike between
  trees."

### Mud (new)

- **Generation:** low-lying land bordering water — elevation in
  `[WATER_LEVEL, WATER_LEVEL + MUD_BAND ≈ 0.05]`, plus optional noise-gated
  marsh patches. Cheap, deterministic, same fbm pass.
- **Storage:** generalize the private `water: Uint8Array` into a `ground`
  type grid (`0 land / 1 water / 2 mud`) rather than adding a third parallel
  array — `isWaterAt` keeps its signature; add `mudAt`. `cover` stays its own
  float grid (it's a density, not a class).
- **Effect:** max-speed multiplier like brush (`MUD_SLOW ≈ 0.5` at full),
  no cover benefit, no damage effects. Punishes cavalry the same emergent way.
- **Renderer:** dark wet brown in the ground bake; bake-time cost only
  (per-frame perf untouched).

---

## 6. Rendering

- Sprite bins re-key from `type` to `arch`: bins =
  `team × ARCHETYPE_COUNT × routing × facing`, facing > 1 only for mounted
  archetypes. 7 archetypes ≈ 140 baked sprites worst case — still trivial,
  all bake-time.
- Per-archetype look tables replace `TYPE_ACCENT/BRIGHT/SCALE`: mounted →
  horse stamp (exists), armor tier → brightness/accent weight (heavy reads
  bright/metallic, unarmored reads flat), weapon → small glyph accent (the
  archer's bowstave pixel today generalizes). Art details deferred; the plan
  only fixes the bin key and table shape.

---

## 7. Spawning & army composition

- `ARMY_MIX` becomes per-archetype. Near-term: same three-entry mix mapped to
  knights/longbowmen/pikemen for parity, then widen.
- The todo's "expensive" cavalry implies a **cost axis**: give each archetype
  a `cost` and generate armies from a points budget instead of fractions.
  Useful for balance testing (equal-budget armies) and later for the AI
  director's supply layer. Proposed as a later phase, not a blocker.

---

## 8. Historical feel — sim, not RTS

Worth stating what makes this design read as a *simulation* rather than an
RTS counter-chart: the RPS table we're deleting **is** the typical-RTS
mechanic. After the rework, matchups are consequences of physical properties
(reach, mass, armor vs. projectile energy, ground) rather than authored
counters — which is the Total War instinct, minus its stacked hidden stats
and matched-combat choreography. Depth here should come from **few, visible
mechanisms interacting**, per the north star.

Three principles, settled:

- **Routing units don't fight back — that *is* the pursuit advantage.** No
  pursuit damage modifier, and no targeting change either: routers stay
  valid targets (chase them down when it's worth the time), but a ROUTING
  unit deals no damage to anyone. The strike branch's ACTIVE gate already
  guarantees this today — the pursuer's edge is a free hand, not a
  multiplier. Nothing to build; the principle is recorded here so nobody
  "improves" it later.
- **Stats are sustainable rates — no fatigue resource.** Every speed and
  cooldown in §2 reads as "what the unit can do sustainably without
  over-wearing itself." Conceptually simpler than a fatigue meter driving
  variable paces, and it keeps the tuning surface flat. If a burst-vs-sustain
  distinction is ever needed somewhere specific, the lance is the pattern to
  copy: scale off state the sim already computes — current speed, distance,
  cover — never a new meter or resource.
- **Discipline is a unit property, not an archetype property** — designed
  for now, wired later. Morale behavior must not be hard-coded to archetype
  tables: the future wants squad variants like a "berserker" blade-infantry
  squad that is much harder to rout than regular blades of the *same*
  archetype. Hook: a per-unit `discipline` scalar (see §1) that scales
  `ROUT_THRESHOLD` / `RALLY_THRESHOLD` and/or the fear rates; archetypes
  provide a default and the spawner can override per squad. The field lands
  in phase 1 (it's four bytes); wiring it into morale waits until variants
  exist.

Deliberately *not* imported from Total War: facing/attack arcs, matched
combat, unit experience ladders, ability buttons. If a mechanic needs a
tooltip, it doesn't belong here.

## 9. Performance & determinism notes

- Every new per-unit stat read is a Uint8/Float32 index into a small table —
  same shape as `TYPE_*` today. The weapon matrix flattens to one
  `Float32Array(WEAPON_COUNT × ARMOR_COUNT)`.
- Discrete strikes are *cheaper* than continuous DPS (most units are on
  cooldown most ticks; the scan already ran anyway).
- No new RNG anywhere in combat → seed determinism untouched.
- The one real hot-loop risk is the polearm scan widening (§3); measure it.
- **Balance harness — plain node, no browser.** The sim is DOM-free by
  design and package.json is `"type": "module"`, so node imports
  `src/sim/*.js` directly: no build step, no bundler, no browser. A
  `test/balance.js` script seeds `world.init(seed)`, calls `world.step()` in
  a tight loop (thousands of ticks per second, faster than realtime), and
  prints survivors by archetype per matchup across N seeds. package.json:

  ```json
  "balance": "node test/balance.js",
  "balance:matrix": "node test/balance.js --matrix"
  ```

  (`--matrix`: every archetype squad vs. every other, equal counts — equal
  *cost* once phase 6 lands.) This is how §2's numbers get tuned instead of
  eyeballing 5000 dots.

  Playwright / headless Brave is **not needed for this** — a browser only
  adds startup cost and a dev dependency to reach the same pure functions.
  Where a browser harness *would* earn its keep is a later renderer smoke
  test (does a frame draw without throwing, screenshot diffs); out of scope
  for this rework, noted here so we don't re-litigate it.

---

## 10. Phasing — each step ships green

1. **Axes under the hood, no behavior change.** Add Armor/Weapon/archetype
   tables to config; rename `type` → `arch`; map the three current types;
   derive speed/hp from the new tables tuned to match today's values exactly.
   Renderer re-keys bins. Pure refactor, verifiable by seed-identical replay… 
   (near-identical: hp/speed rounding may drift a battle — check visually).
2. **Discrete strikes + weapon matrix — lands together with the balance
   harness.** Replace the melee DPS line with the strike loop,
   `WEAPON_VS_ARMOR`, polearm reach profile + standoff, widened polearm
   scan. Delete `DMG_MULT`/`TYPE_ARMOR`/`TYPE_MELEE_DPS`. `test/balance.js`
   + the `npm run balance` scripts (§9) ship in the same change and gate it:
   pike > cavalry > archers > pike must hold in the matrix runs, not just
   look right on screen. Targeting of routing units stays as today: valid
   victims who never strike back (§8).
3. **Ranged split.** Parametrize `archery.js` per weapon; longbow stationary
   gate; shooter-side cover; `MOUNT_ARROW_MULT`. Add skirmishers to the
   roster.
4. **Lance.** Speed-scaled lance damage off real per-tick displacement (no
   stored state); knights re-armed from generic melee to LANCE. The old
   charge-mechanic tuning reference lives at `585a113`.
5. **Terrain.** `ground` grid with mud + generation + renderer bake + speed
   effect; polearm brush cooldown.
6. **Roster & cost.** Full initial roster (light horse, sergeants), archetype
   costs, budget-based army generation, per-archetype `ARMY_MIX`. The
   balance harness's `--matrix` mode switches from equal counts to equal
   cost here.
7. *(future, unscheduled)* **Squad variants** — wire the `discipline` scalar
   (§8) into morale and let the spawner mint variant squads (berserkers
   etc.). The field itself lands in phase 1; this phase is just the wiring,
   whenever variants are wanted.

Each phase is a small PR-sized change touching a known file set:
config.js + units.js + world.js + test/balance.js (1–2), archery.js (3),
world.js (4), terrain.js + renderer.js (5), world.js spawn + config (6).

---

## 11. Open questions

1. **Longbow interrupted mid-reload: pause or reset?** Plan says pause
   (cooldown just doesn't tick while moving). Reset is harsher and makes
   longbow repositioning a bigger commitment. → §4
2. **Armor & morale?** Should heavy armor also resist morale damage (HIT_FEAR
   scaled), or is protection-via-matrix enough? Plan: leave morale untouched
   for now; the per-unit `discipline` scalar (§8) is the cleaner home for
   this if wanted (heavier archetypes default to higher discipline).
3. **Cost/budget armies in phase 6 — or sooner?** Equal-count matrix runs
   are fine for early tuning; costs are just a config number if we want them
   earlier.
4. **Charge morale shock:** should a full-gallop lance impact also deal bonus
   fear (the old mechanic's ghost)? Plan: defer, revisit after phase 4 play.

Resolved: polearm in brush is a **penalty** (longer cooldown and/or lower
damage — the todo's "and/or dmg" meant *decrease*); the balance harness lands
with phase 2, plain node, no browser automation; **no pursuit damage
modifier** — routers stay attackable, and the pursuit advantage is simply
that they never strike back, already true via the ACTIVE gate (§8); **no
fatigue** — stats are sustainable rates by definition (§8); **no charge
meter** — lance damage scales off current actual speed, no stored state
(§3); discipline is a per-unit scalar decoupled from archetype, reserved now
and wired when squad variants arrive (§8).
