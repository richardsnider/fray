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
- Melee combat, morale, and routing with panic contagion (`src/sim/world.js`).
- `ImageData` pixel renderer with value-noise terrain (`src/render/renderer.js`).

Two armies (silver vs. red) spawn and march into each other. Units in reach trade
damage; morale drains from being outnumbered, taking hits, and standing near
fleeing friends. Below a threshold a unit **routs** (dim dots) and runs; if it
reaches safety and recovers, it re-forms. **Click** to redirect your (silver)
army. The HUD shows per-team survivors, FPS, and sim time per frame.

## Architecture

```
src/
  config.js          tuning knobs (rates, sizes, speeds, colors)
  main.js            fixed-timestep loop wiring
  sim/               deterministic core — no DOM
    units.js         SoA typed-array unit store
    spatialGrid.js   linked-list uniform grid
    world.js         steering + integration
  render/
    renderer.js      Canvas/ImageData drawing + terrain
  input/
    input.js         player command layer
```

## Roadmap

- ~~Combat + morale/routing (panic contagion via the spatial grid)~~ ✅ done
- Camera (pan/zoom) so the world can be larger than the screen
- Terrain effects (elevation on speed/charge, cover vs. archers, water)
- Flow-field pathfinding for large groups
- Unit types (heavy cavalry, longbow, pike/melee)
- AI director: idle groups get objectives (raid, forage, screen, siege)
- Supply lines, razing farmland, raiding villages, sieges
