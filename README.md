# fray

A lightweight, dependency-free browser war/battle simulator set in ~1450 Europe.
Vanilla JS, Canvas 2D, no build step.

## Run

ES modules must be served over HTTP (opening `index.html` via `file://` won't
load the modules). From the repo root:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Any static server works.

## Current state: vertical slice

- Fixed-timestep (33 Hz) sim loop, decoupled from rendering with interpolation.
- Structure-of-Arrays units in typed arrays (`src/sim/units.js`) — GPU-shaped for
  a future WebGL renderer.
- Uniform spatial-hash grid (`src/sim/spatialGrid.js`) for O(1)-ish neighbor
  queries.
- Boids-style steering: seek objective + friend-only separation (`src/sim/world.js`).
- Three unit types — heavy cavalry, longbow archers, pike/melee — with
  data-driven stats, a rock-paper-scissors damage table, ranged bow fire, and
  cavalry charges (`src/config.js`, `src/sim/world.js`).
- Melee combat, morale, and routing with panic contagion (`src/sim/world.js`).
- Camera over a fixed world larger than the screen (`src/render/camera.js`).
- Terrain grid (elevation/water/brush) that feeds both the sim and the renderer
  (`src/sim/terrain.js`).

Two armies (silver vs. red) spawn and march into each other on a 3200×2000 world.
Units in reach trade damage; morale drains from being outnumbered, taking hits,
and standing near fleeing friends. Below a threshold a unit **routs** (dim dots)
and runs; if it reaches safety and recovers, it re-forms.

The terrain is real: **water is impassable** (units slide along shorelines),
**hills slow the climb and speed the descent**, **brush slows movement**, and
**attacking downhill hits harder**. Marching armies follow a per-team **flow
field** that routes them *around* water toward the objective — including wherever
you click. The HUD shows per-team survivors, FPS, zoom, and sim time per frame.

**Controls:** left-click orders your (silver) army · right-drag or WASD/arrows pan
· mouse wheel zooms toward the cursor.

## Architecture

```
src/
  config.js          tuning knobs (rates, sizes, speeds, colors)
  main.js            fixed-timestep loop wiring
  sim/               deterministic core — no DOM
    units.js         SoA typed-array unit store
    spatialGrid.js   linked-list uniform grid
    terrain.js       elevation/water/brush grids + sampling
    flowField.js     BFS flow-field pathfinding (one field per army)
    rng.js           seeded PRNG (mulberry32) so a seed reproduces a battle
    world.js         steering, combat, morale, terrain integration
  render/
    camera.js        viewport: world<->screen transform, pan/zoom, clamping
    renderer.js      Canvas drawing (terrain blit + culled units)
  input/
    input.js         player command layer
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
**flow-field pathfinding** ✅ · **unit types** ✅. Remaining work, in dependency
order:

### 1. AI director — the "plays itself" brain

*Depends on unit types (objectives reference roles).*

- **Groups, not one blob.** Replace "whole team seeks one centroid" with a
  handful of **groups** per side (spatial clustering or fixed bands), each with
  its own objective + flow field (we already run N fields cheaply).
- **Per-side general:** a utility planner that scores candidate objectives
  (engage enemy group, defend, raid village, forage supply, screen a flank,
  besiege) by threat / opportunity / supply, and assigns the best to each group.
- **The 30-second rule:** each group tracks time since its last meaningful
  action; a bot general reassigns any group idle past the threshold (config
  knob). *Assumption:* the **player's** idle units stay put — only bot generals
  auto-utilize idle troops; the player is exempt.
- *Assumptions:* coarse objectives (go-to / attack / raid / defend / besiege),
  not choreography; ~4–12 groups per side to keep planning + flow-fields cheap;
  planner runs on a fixed cadence with seeded RNG so the sim stays deterministic.

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
