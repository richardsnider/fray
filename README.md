# fray

A lightweight, dependency-free browser war/battle simulator set in ~1450 Europe.
Vanilla JS, Canvas 2D, no build step.

## Run

ES modules must be served over HTTP (opening `index.html` via `file://` won't
load the modules). From the repo root:

```sh
python3 -m http.server 8080   # or: npm run serve
# then open http://localhost:8080
```

Any static server works.

## Development

The game itself has **zero runtime dependencies**. See package.json for dev scripts.

## Current state: vertical slice

- Fixed-timestep (33 Hz) sim loop, decoupled from rendering with interpolation.
- Structure-of-Arrays units in typed arrays (`src/sim/units.js`) — GPU-shaped for
  a future WebGL renderer.
- Uniform spatial-hash grid (`src/sim/spatialGrid.js`) for O(1)-ish neighbor
  queries.
- Boids-style steering: seek a per-unit rally point + friend-only separation,
  with reactive shoreline avoidance (`src/sim/world.js`).
- Three unit types — heavy cavalry, longbow archers, pike/melee — with
  data-driven stats and a rock-paper-scissors damage table
  (`src/config.js`, `src/sim/world.js`).
- Massed archery as **area fire** (`src/sim/archery.js`): each volley targets
  the densest enemy cell in bow range (the beaten zone) and lands after a
  flight delay on whoever is standing there — friend or foe — so units can
  walk out from under a volley and arrows into a melee cut both ways.
- Melee combat, morale, and routing with panic contagion (`src/sim/world.js`).
- Camera over a fixed world larger than the screen (`src/render/camera.js`).
- Terrain grid (elevation/water/brush) that feeds both the sim and the renderer
  (`src/sim/terrain.js`).

Two armies (silver vs. red) deploy as clustered single-type squads on a
3200×2000 world, each squad marching toward its own objective on the enemy's
half so the battle breaks into several fronts. Units in reach trade damage;
morale drains from being outnumbered, taking hits, and standing near fleeing
friends. Below a threshold a unit **routs** (dim dots) and runs; if it reaches
safety and recovers, it re-forms.

The terrain is real: **water is impassable** (units slide along shorelines),
**hills slow the climb and speed the descent**, **brush slows movement**, and
**attacking downhill hits harder**. Each unit marches toward its own **rally
point** — its squad's spawn objective, or wherever you last commanded the
selection it belongs to — steering straight for it while reactively veering off
any open water ahead. The HUD shows per-team survivors, FPS, zoom, and sim time
per frame.

**Controls:** left-drag box-selects your (silver) units · left-click a rally flag
grabs its squad · left-click the ground orders the current selection there ·
right-drag or WASD/arrows pan · mouse wheel zooms toward the cursor · space
pauses.

## Architecture

```
src/
  config.js          tuning knobs (rates, sizes, speeds, colors)
  main.js            fixed-timestep loop wiring
  sim/               deterministic core — no DOM
    units.js         SoA typed-array unit store
    spatialGrid.js   linked-list uniform grid
    terrain.js       elevation/water/brush grids + sampling
    archery.js       massed volley fire: beaten-zone aiming + arrow-flight queue
    rng.js           seeded PRNG (mulberry32) so a seed reproduces a battle
    rally.js         rally-flag store — single source of truth for march targets
    command.js       player selection + orders (repoints rally flags)
    world.js         steering, combat, morale, rally-point marching
  render/
    camera.js        viewport: world<->screen transform, pan/zoom, clamping
    renderer.js      Canvas drawing (terrain blit + culled units)
    flag.js          rally-flag geometry shared by drawing + click hit-testing
  input/
    input.js         player command layer
  util/
    math.js          shared pure helpers (lerp, clamp/clamp01/clampIndex, smoothstep)
    grid2d.js        uniform-grid helpers (world→cell indexing, bilinear sampling)
```

**Code style — data-oriented & functional.** There are no classes. Each module
owns plain data (typed arrays or a small state record) and exposes standalone
functions that take that state as their first argument — e.g. a spatial grid is
`Grid.create(w, h, cell)` → `{ cell, cols, rows, heads, next }`, mutated by
`Grid.build(grid, …)`; a camera is a plain `{ x, y, zoom, … }` acted on by
`Camera.panByScreen(cam, …)`. Modules are imported as namespaces (`import * as Grid`) 
so call sites read `Grid.build(grid, …)`. Functions are arrow bindings
(`export const f = (a, b) => …`), expression-bodied wherever a block-and-`return`
isn't genuinely needed. This keeps state transparent (trivial to snapshot for
determinism) and the sim easy to test as pure-ish functions. The performance
story is unchanged — it's the SoA typed arrays, not the object model.

Control flow leans on expressions over statements: **`cond && (a, b)`** for a
conditional side effect, **`x = c ? p : q`** for value selection, and the
`util/math.js` clamps (`clamp`, `clamp01`, `clampIndex`) for range-clamping
rather than hand-rolled ternary chains. `if` is reserved for the cases
where it's genuinely required — a guard that `return`/`continue`s, or a block that
declares a local `const` for multi-statement math.

## Vision & success criteria

**North star:** a lightweight, vanilla-JS, browser battle simulator of ~1450
European (pre-gunpowder) warfare that sits *between a simulation and an RTS*. It
largely **plays itself**; the player is a rogue-ish commander who drops in and
directs units rather than micromanaging everything.

Checklist to measure the finished product against (✅ = met today, ⬜ = pending):

**Scope & feel**
- ⬜ Plays itself — uncommanded units keep acting; the battle never just freezes
- ⬜ Enemy generals reactivate any troop **idle > 30 s** with a fresh objective
- ⬜ Player is a *drop-in* commander (inject/order own units, not command all)
- ⬜ Reads as a sim ⟷ RTS hybrid, **not** a Civ-style 4X
- ✅ Setting is ~1450 Europe, pre-gunpowder (no firearms/artillery)

**Combatants (pre-gunpowder arms)**
- ✅ Heavy armored cavalry · longbow archers · melee/pike infantry
- ✅ Rock-paper-scissors interplay (pike > cavalry > archers > pike, roughly)

**Systemic warfare**
- ✅ Morale and routing
- ⬜ Supply lines · razing farmland · raiding villages · sieges

**Scale, presentation & tech (deliberately basic)**
- ✅ Thousands of dots on screen, smoothly, in-browser
- ✅ Green/brown noise ground · blue impassable water (no naval) · slope shading ·
  semi-transparent brush · one dot per soldier
- ✅ Vanilla JS, no big libraries; Canvas now, WebGL reserved as a drop-in swap

**Explicit non-goals:** gunpowder, naval warfare, a 4X economy / tech tree /
city-building, and rigid formation micro. Supply is about *denial and morale*,
not production.

## Roadmap

Done: **combat/morale** ✅ · **camera** ✅ · **terrain effects** ✅ ·
**squad rally marching** ✅ · **unit types** ✅. Remaining work, in dependency
order:

### 1. AI director — the "plays itself" brain

*Depends on unit types (objectives reference roles).*

- **Groups, not one blob** — *partly here already.* Armies deploy as single-type
  squads, each marching to its own rally point, so the "whole team seeks one
  centroid" blob is already gone. What's left is letting a planner group and
  regroup those squads under fresh objectives instead of the fixed ones minted at
  spawn.
- **Per-side general:** a utility planner that scores candidate objectives
  (engage enemy group, defend, raid village, forage supply, screen a flank,
  besiege) by threat / opportunity / supply, and assigns the best to each group.
- **The 30-second rule:** each group tracks time since its last meaningful
  action; a bot general reassigns any group idle past the threshold (config
  knob). *Assumption:* the **player's** idle units stay put — only bot generals
  auto-utilize idle troops; the player is exempt.
- *Assumptions:* coarse objectives (go-to / attack / raid / defend / besiege),
  not choreography; ~4–12 groups per side to keep planning cheap; planner runs on
  a fixed cadence with seeded RNG so the sim stays deterministic.

### 2. Strategic layer — supply · razing · raiding · sieges

*Depends on the director (these are objectives it pursues).*

- **Map features as sparse entities** (not per-pixel): villages, farmland,
  supply depots, fortifications — small arrays of position + state
  (intact/raided/razed, supply value, fortification HP + garrison).
- **Supply** as denial: each side's supply level is fed by held
  villages/depots; a unit's effective supply falls with distance from a friendly
  source (approximate via a supply flow field / nearest-source distance). Low
  supply **drains morale** — it plugs straight into the existing morale system
  rather than adding a resource economy.
- **Razing / raiding:** objectives where units dwelling next to a farmland or
  village tile flip its state over time, cutting the enemy's supply value.
  Visuals: razed farmland changes color, raided village shows damage.
- **Sieges:** fortified points have HP + a garrison and big defensive bonuses;
  besieging = encircle + attrition, or assault. *Assumption:* walls are
  impassable terrain segments plus a fortification feature with HP — attrition
  and assault resolution, no breach animation.
- *Assumptions:* the strategic features are a thin layer **over** the tactical
  sim, not a second game mode; still no economy/production; naval stays out.

### Backlog — unscheduled design notes

- **Bow classes vs. armor tiers.** Split archery into shortbow/longbow classes
  against armor tiers instead of one RPS row: shortbows threaten only
  unarmored/padded troops, longbows defeat mail + padding but not late-period
  full plate (which is near arrow-proof frontally), and horses stay vulnerable
  regardless — massed volleys break a charge through the mounts, not the
  riders. Today's `DMG_MULT` row + `TYPE_ARMOR` approximates this; revisit
  when unit types grow.
- **Archer fire discipline.** Volley aiming is deliberately dumb (densest
  enemy cell, friendly fire included). Hold-fire judgement — not volleying a
  melee your own pikes are winning — belongs to the AI director, not the
  archers; it's a one-line score tweak in `sim/archery.js` when the director
  lands.
- **Cavalry charges.** An earlier charge mechanic (burst damage + morale shock
  when a fast-moving knight hit contact, negated by braced pikes) was removed:
  its raw-velocity trigger never fired after the steering refactor capped
  stored velocity below the charge threshold, and even before that it only
  triggered off separation shoves in a packed melee, not an open-field run-up.
  Pike > cavalry survives via the `DMG_MULT` table. If revived, redesign the
  trigger around an actual run-up (e.g. ticks spent closing on the target at
  marching pace or above) rather than instantaneous velocity; the old tuning
  lives in git history (`585a113` and earlier).
