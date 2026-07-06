# Plan: unit rework — armor × weapon axes

Status: **in implementation** — phases 1–3 landed (§10). Numbers are starting
points, not balance.
Source notes: `todo` (repo root) + README backlog (bow classes vs. armor tiers,
cavalry charges, archer fire discipline).

## Goal

Replace the three hard-coded unit types (knight / archer / pike) and their
single rock-paper-scissors table with two orthogonal axes — **armor tier** and
**weapon class** — plus a **mount** flag. Matchups stop being an authored
type-vs-type matrix and instead fall out of how weapons interact with armor,
distance, movement, and terrain. Flanking, charge run-ups, and formation depth
become emergent rather than scripted.

This is a rework of the combat core, not a patch: the damage model is rebuilt
around weapon profiles, and archery splits into two classes. We accept
refactoring `world.js` combat and `archery.js` to get there.

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
- `cooldown` (exists) — stays the ranged volley-reload timer, now per bow
  class (§4). Melee needs no per-unit combat state at all (§3).
- ~~**new** `steady`~~ — *not needed, settled in phase 3*: the stand-still
  rule's movement-*reset* formulation (§4) needs no accumulated standing time;
  the reload branch reads the tick's actual travel directly and either ticks
  the existing `cooldown` down or restarts it.
- **future** `routAt` (Uint8, per-unit rout threshold) — for squad variants
  (berserkers etc., see §8). Not added in phase 1: today's global
  `ROUT_THRESHOLD` is the degenerate case (every unit the same), so the
  array lands only when variants do (phase 7).

`spawn` and `copyUnit` pick up the new fields. ~4 bytes/unit added — noise.

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
WEAPON_DPS      = [     16,    14,      18,    —,       —,     8 ]  // melee hp/sec
// polearm dps is at full reach (§3 profile) and assumes a braced foot pike —
// mounted polearms take POLEARM_MOUNT_MULT ≈ 0.6 on it (§3). Lance dps is
// standing still (§3), deliberately below even an unbraced mounted polearm:
// a lance is nothing without speed.
// Ranged weapons are volley events, not rates (see §4):
//                     BOW  LONGBOW
VOLLEY_DMG      = [     14,      30 ]  // per volley
VOLLEY_RELOAD   = [    0.9,     1.6 ]  // seconds

// Weapon-vs-armor damage multiplier (replaces DMG_MULT):
//                      vs NONE  vs ARMORED  vs HEAVY
WEAPON_VS_ARMOR = [
  /* BLADE   */        [  1.3,      0.85,      0.6  ],  // cuts notch on mail
  /* BLUNT   */        [  1.0,      1.1,       1.3  ],
  /* POLEARM */        [  1.0,      1.0,       1.0  ],  // power is in reach, not matchup
  /* BOW     */        [  1.0,      0.55,      0.15 ],  // shortbow: armor shrugs it off
  /* LONGBOW */        [  1.3,      1.0,       0.5  ],  // defeats mail, not plate
  /* LANCE   */        [  1.2,      1.0,       0.9  ],  // × speed bonus, see §3
]

MOUNT_ARROW_MULT = 1.4   // BOW/LONGBOW damage vs mounted units below HEAVY:
                         // unbarded horses die to massed arrows (README backlog)

POLEARM_VS_MOUNT = 1.5   // polearm melee damage vs mounted, any tier: a set
                         // pike stops the horse itself — barding blocks
                         // arrows, not a braced point (melee analog of
                         // MOUNT_ARROW_MULT)
```

Sanity check vs. today: pike 14 dps → polearm 18 dps *at full reach*, near
zero adjacent. Knight melee 18 dps → lance 8 dps standing (helpless in a
press) but many-fold that while still moving at contact. Longbow volley 30
stays.

---

## 3. Melee rework: single-target dps × weapon profiles

Melee **stays continuous `dps × dt` against the closest enemy only** — the
model already in `world.js`. Discrete cooldown-gated strikes were considered
and dropped: what makes **flanking emergent** (the todo's bet) is
*single-targeting* — three levies around one sergeant pour in 3× dps and eat
1× back — and the current code already has that property. Strike timing
would add per-unit state and tick-aliasing without adding behavior; the
"attack speed" ideas in the todo all collapse into rate tuning. Cooldowns
live only where the action is genuinely an event: ranged volleys (§4).

What changes is how the damage rate is computed — every factor a
multiplicative read of state the sim already computes:

```
dmg[target] += WEAPON_DPS[w] × dt
             × WEAPON_VS_ARMOR[w][targetArmor]   // the §2 matrix
             × heightBonus                       // unchanged
             × reachProfile(w, d)                // polearm, below
             × speedScale(w, i)                  // lance, below
             × terrainMods                       // brush, §5
```

accumulated into `dmg[]` as today, so resolution stays order-independent.
The todo's "slower attack speed" for polearms folds into `WEAPON_DPS`
tuning — in a continuous model, a longer cooldown and lower damage are the
same knob.

**Polearm reach profile.** Damage scales with distance to the target:
near-max reach ≈ full rate (the deadliest melee in the game), adjacent ≈
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

**Polearms are anti-cavalry in themselves** (`POLEARM_VS_MOUNT`, §2): a
braced point kills the horse, a big target barding can't save, so the bonus
applies at any armor tier — the reason *unarmored* pike levies historically
stopped heavy cavalry (schiltrons, Courtrai). Verified in the harness with
temporary archetypes: heavy blunt cavalry beat unarmored pikes 1748/972
without the bonus and loses 1080/1541 with it, while blade knights still cut
down levy pikes (armored pikemen are the true counter). One `ARCH_MOUNTED`
read folded into the polearm profile branch — no cost to other weapons.

**Mounted polearms keep the reach, not the rate.** The full polearm rate is
a braced two-handed foot pike; a rider thrusts one-handed, so mounted ×
POLEARM takes `POLEARM_MOUNT_MULT ≈ 0.6` on the dps — baked into the
flattened per-archetype dps (`ARCH_MELEE_DPS`) at config load, so the hot
loop still makes one indexed read. That slots a future demi-lancer /
mounted-sergeant between lance cavalry (all speed, nothing standing) and
foot pikes (all brace): good reach, a moderate sustained rate, no charge
spike. The lance's standing 8 sits deliberately below this unbraced rate.

**Standoff distance.** An engaged unit currently presses to contact. A
polearm unit should hold at reach instead: engaged units seek the enemy only
while `d > STANDOFF[w]` (≈ `0.7 × range` for polearm, ~0 for blade/blunt).
Blades then naturally burrow into pike ranks while pikes back-pedal to reach —
the counter-play the todo wants, driven by one comparison in the move-desire
branch.

**Lance — damage scales with current speed. No meter, no stored state.**
The todo's "high dmg when moving," taken literally: the lance's `speedScale`
reads the striker's **actual per-tick travel** — velocity × terrain factor ×
pace, the real displacement, *not* the capped raw steering velocity whose
ceiling killed the old charge mechanic (README backlog):

```
speedFrac  = travel / maxTravel(unit)         // 0 standing … 1 at full gallop
speedScale = 1 + speedFrac × LANCE_SPEED_MULT
```

- The run-up falls out of the movement model for free: from a standstill,
  damping takes on the order of a second of open ground to ease a knight up
  to gallop, so a knight starting adjacent to its target never hits hard,
  while one arriving off a field crossing deals several times its standing
  rate for the moments it is still moving. Milling in a press means
  near-zero travel and the worst weapon in the game — per the todo, lance
  damage "is still really bad at shorter melee distances like infantry."
- The crash is a **self-limiting burst**: contact at gallop lasts only a
  handful of ticks before the press bleeds the knight's speed, so
  `LANCE_SPEED_MULT` needs to be large for the impact to read — with the
  standing rate at 8, start ~8 (gallop ≈ 72 hp/sec for the moments it
  lasts), tune in the harness.
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
what this rework bets on: single-target melee is where flanking, reach
profiles, and formation depth come from.

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
the reload only counts down while the unit is stationary (per-tick travel
below an epsilon), and any movement **resets it to the full reload** — the
archer must stand still for one *uninterrupted* reload before the next
volley. Repositioning a longbow line is a real commitment; plant them early.
Still one branch on the existing `cooldown -= dt` line (moving →
`cooldown = VOLLEY_RELOAD`, stationary → tick down). The gentler
alternative — pausing the countdown and letting standing time accumulate
across interruptions — was considered and rejected as making longbows too
freely mobile.

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
- **Polearm awkwardness in trees** (confirmed: a penalty) — with melee as a
  continuous rate (§3), "longer cooldown" and "lower damage" are the same
  knob: `dps × (1 − cover × POLEARM_BRUSH ≈ 0.4)`, one factor off a terrain
  read already in hand.

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

Five principles, settled:

- **Routing units don't fight back — that *is* the pursuit advantage.** No
  pursuit damage modifier, and no targeting change either: routers stay
  valid targets (chase them down when it's worth the time), but a ROUTING
  unit deals no damage to anyone. The strike branch's ACTIVE gate already
  guarantees this today — the pursuer's edge is a free hand, not a
  multiplier. Nothing to build; the principle is recorded here so nobody
  "improves" it later.
- **Stats are sustainable rates — no fatigue resource.** Every speed, rate,
  and reload in §2 reads as "what the unit can do sustainably without
  over-wearing itself." Conceptually simpler than a fatigue meter driving
  variable paces, and it keeps the tuning surface flat. Plain per-unit
  timers (the volley reload) are fine; what's out is open-ended resource
  management — fatigue bars, charge-up meters, anything that accumulates
  and must be managed. If a burst-vs-sustain distinction is needed
  somewhere, the lance is the pattern: scale off state the sim already
  computes (current speed, distance, cover).
- **No charge morale shock — fear comes only from damage taken.** A
  full-gallop lance impact deals no bonus fear: the burst of damage already
  drains the victim's morale through the normal hit path, so the shock is
  physical, same as every other weapon. No fear multiplier riding
  `speedScale`, now or later — recorded here so nobody "improves" it after
  phase 4.
- **Armor protects the body, not the nerve.** Heavy armor does not scale
  `HIT_FEAR` or any other morale input. Protection lives entirely in
  `WEAPON_VS_ARMOR`, and since fear follows damage taken, armor already
  shields morale *indirectly* — an explicit armor-fear scale would
  double-count, exactly what §1 forbids for damage. If heavier archetypes
  should hold longer than their hp advantage explains, that's a lower
  `routAt` default (below), not an armor mechanic.
- **Bravery is a per-unit rout threshold — no discipline scalar, no second
  meter.** Morale behavior must not be hard-coded to archetype tables: the
  future wants squad variants like a "berserker" blade-infantry squad that
  is much harder to rout than regular blades of the *same* archetype. An
  earlier draft reserved a `discipline` scalar that would multiply the
  thresholds; that abstraction is dropped — the knob *is* the threshold,
  stored directly. A per-unit `routAt` (see §1), precomputed at spawn: a
  unit routs when morale ≤ `routAt[i]` and rallies past
  `routAt[i] + RALLY_GAP` (today's 30-point hysteresis, kept). Archetypes
  provide the default, the spawner overrides per squad (berserkers ≈ 5,
  regulars 25). Cost is one indexed read replacing a constant in the
  damage-resolve pass — no per-tick multiply. The fear *rates*
  (outnumbered, contagion, hit-fear) stay global: scaling them per unit
  would touch three drain lines every tick for the same behavior. The
  morale accumulator itself is untouched — it is already the minimal
  robust mechanism (all its inputs are free byproducts of the neighbor
  scan, and the hysteresis needs the stored meter anyway).

Deliberately *not* imported from Total War: facing/attack arcs, matched
combat, unit experience ladders, ability buttons. If a mechanic needs a
tooltip, it doesn't belong here.

## 9. Performance & determinism notes

- Every new per-unit stat read is a Uint8/Float32 index into a small table —
  same shape as `TYPE_*` today. The weapon matrix flattens to one
  `Float32Array(WEAPON_COUNT × ARMOR_COUNT)`.
- Melee damage stays the single accumulate line it is today; the new factors
  are table reads and multiplies. No new per-tick cost, no new per-unit
  combat state.
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

1. **Axes under the hood, no behavior change.** ✅ *Done.* Armor/Weapon/
   archetype tables in config (flattened to `ARCH_*` plain arrays — full-f64
   stats, so no rounding drift at all); `type` → `arch` through units/world/
   archery/command; renderer bins re-keyed with mounted → horse + facings and
   bow-class → bow arc driven by the axes. Interim tables (`ARCH_MELEE_DPS`,
   `ARCH_DMG_REDUCE`, `DMG_MULT`) carry combat until phase 2. Verified
   seed-identical: byte-exact FNV hash over all unit arrays after 3000 ticks
   matches the pre-refactor code across three seeds.
2. **Weapon matrix + profiles — lands together with the balance
   harness.** ✅ *Done.* Melee stayed `dps × dt`; the interim per-archetype
   tables died for `WEAPON_DPS` × `WEAPON_VS_ARMOR`; polearm reach profile,
   standoff, and the widened polearm scan landed, plus the §2 armor
   speed/hp targets (knights now pace 1.26). Engaged units no longer regen
   morale (a polearm fighting at reach 8–11 is outside the awareness radius
   but must not recover mid-fight). `world.init` grew an optional
   `{ mix0, mix1, size }` override for the harness, which re-points rally
   flags at the map center so matchups collide. Gate results (500 v 500,
   6000 ticks, 5 seeds × both sides): pikemen > knights 2888/603,
   knights > longbowmen 2869/375, longbowmen > pikemen 3002/288 — the
   triangle holds, with pike > cavalry emphatic. Tunes against the harness
   got it there: BLADE vs ARMORED 1.0 → 0.85 (cuts notch on mail), polearm
   dps 16 → 18, and `POLEARM_VS_MOUNT` 1.5 (§2–3) — at the draft numbers
   the pike win was a near-coinflip 1794/1612, a burrowed knight trading
   too well against 105 hp pikes, and unarmored pikes lost outright to
   heavy cavalry. Also settled here: mounted polearms bake ×0.6 can't-brace
   into `ARCH_MELEE_DPS`, and lance standing dps dropped 12 → 8, below the
   unbraced mounted polearm (§2–3). The longbow-vs-pike margin is lopsided;
   leave it until phase 3's stand-still rule nerfs longbows naturally, then
   retune. Scan
   widening measured (§3's caveat): ~1.3 ms vs ~0.9 ms per tick at ~5k
   units in node, part of it more survivors to simulate — ~25× realtime
   headroom, so the aim-grid gating fallback stays unneeded. Targeting of
   routing units stays as today: valid victims who never strike back (§8).
3. **Ranged split.** ✅ *Done.* `archery.js` parametrized per bow class
   (`BowClass` BOW/LONGBOW): per-class range/reload/damage off
   `WEAPON_RANGE`/`VOLLEY_*`, per-class landing grids (the classes bite armor
   differently), and each queued volley carries its damage with the shooter's
   brush cover already paid (§4's both-ways rule). `MOUNT_ARROW_MULT` folded
   into a flattened per-victim impact table at load. The longbow stand-still
   rule landed as world.js's reload branch, moved after the position writes so
   it reads the tick's actual travel — no `steady` field (§1). The one
   surprise was the stillness epsilon: formed-up units jitter around their
   formation slot (slot seek is constant-magnitude with no arrival easing) at
   up to ~7 u/s, so at a first-draft epsilon of 2 u/s a planted line never
   completed a reload; `LONGBOW_STILL = 8` u/s sits above the jitter and well
   below the ~16 u/s march. Longbow reload 1.4 → 1.6 (§2 target); skirmishers
   joined the roster and `ARMY_MIX`. Gate results (500 v 500, 6000 ticks,
   5 seeds × both sides): phase 2's lopsided longbow-vs-pike margin resolved
   *by position, not by a number* — ranged matchups are now positional, so
   the harness grew a `--defend` matrix mode (first-named archetype holds its
   spawn ground while the other marches onto it). Colliding marches:
   pikemen > longbowmen 2937/1308 — a marching longbow line never fires.
   Planted: longbowmen > pikemen 4939/4264 with the pike advance shot up and
   routed, and > skirmishers 4728/2707 on range. Knights ride down longbows
   either way (4836/354 colliding, 4059/504 planted), pikemen > knights holds
   (2888/603 colliding, 2782/1755 defending; knights *defending* against
   pikes is a near-stalemate 4776/4911 with both lines mostly intact). The
   triangle survives with its archer leg read as "*planted* archers beat
   pike". Skirmishers lose every static matchup and beat only marching
   longbowmen (3878/3046) — their value is volleying on the move; cost
   arrives phase 6.
4. **Lance.** Speed-scaled lance damage off real per-tick displacement (no
   stored state); knights re-armed from generic melee to LANCE. The old
   charge-mechanic tuning reference lives at `585a113`.
5. **Terrain.** `ground` grid with mud + generation + renderer bake + speed
   effect; polearm brush cooldown.
6. **Roster & cost.** Full initial roster (light horse, sergeants), archetype
   costs, budget-based army generation, per-archetype `ARMY_MIX`. The
   balance harness's `--matrix` mode switches from equal counts to equal
   cost here.
7. *(future, unscheduled)* **Squad variants** — add the per-unit `routAt`
   array (§8), swap the global `ROUT_THRESHOLD`/`RALLY_THRESHOLD` reads for
   `routAt[i]` / `routAt[i] + RALLY_GAP`, and let the spawner mint variant
   squads (berserkers etc.). Field and wiring land together; nothing is
   reserved in earlier phases.

Each phase is a small PR-sized change touching a known file set:
config.js + units.js + world.js + test/balance.js (1–2), archery.js (3),
world.js (4), terrain.js + renderer.js (5), world.js spawn + config (6).

---

## 11. Open questions

None — all resolved:

- **Longbow interrupted mid-reload: reset**, not pause. Moving restarts the
  full reload, so repositioning a longbow line is a real commitment and
  committing them to ground early is rewarded (§4).
- **Armor does not resist morale damage.** Protection lives entirely in
  `WEAPON_VS_ARMOR`; fear already follows damage taken, so armor shields
  morale indirectly and an explicit `HIT_FEAR` scale would double-count.
  Archetype-level morale differences, if ever wanted, are `routAt`
  defaults (§8).
- **Cost/budget armies land in phase 6 as planned.** Equal-count matrix runs
  are sufficient for tuning phases 2–4; cost only becomes meaningful when
  the roster widens, which is phase 6 anyway (§7, §10).
- **No charge morale shock — ever.** A gallop lance impact deals no bonus
  fear; the damage burst drains morale through the normal hit path like
  every other weapon. Settled as a principle in §8, not deferred.

Previously resolved: polearm in brush is a **penalty** (longer cooldown and/or lower
damage — the todo's "and/or dmg" meant *decrease*); the balance harness lands
with phase 2, plain node, no browser automation; **no pursuit damage
modifier** — routers stay attackable, and the pursuit advantage is simply
that they never strike back, already true via the ACTIVE gate (§8); **no
fatigue** — stats are sustainable rates by definition (§8); **no charge
meter** — lance damage scales off current actual speed, no stored state
(§3); **melee stays continuous `dps × dt`** — discrete cooldown strikes
dropped, since single-targeting (already present) is what makes flanking
emergent, and cooldowns belong only to volleys (§3); **no discipline
scalar** — squad-variant bravery is a per-unit rout *threshold* (`routAt`)
stored directly, the fear rates and the morale accumulator stay global and
unchanged, and the field is added only when variants arrive (§8).
