// Wires the pieces together: a fixed-timestep sim loop decoupled from rendering.
// Real time accumulates; the sim advances in fixed TICK_MS steps (deterministic,
// stable); the renderer draws at display rate and interpolates between the last
// two sim states so motion stays smooth even though the sim ticks at ~33Hz.

import * as Renderer from './render/renderer.js';
import * as Camera from './render/camera.js';
import * as Input from './input/input.js';
import * as world from './sim/world.js';
import { hashSeed } from './sim/rng.js';
import { TICK_MS, TICK_S, WORLD_W, WORLD_H } from './config.js';

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const seedInput = document.getElementById('seed');
const speedBar = document.getElementById('speedbar');

// Classic RTS game speed: a multiplier on how fast sim-time accumulates, so the
// fixed-timestep loop below runs proportionally more (or fewer) ticks per real
// second. 0 pauses. Determinism is untouched — every tick is still TICK_S.
let gameSpeed = 1;
let lastPlaySpeed = 1; // remembered so space toggles pause without losing the rate
const MAX_STEPS = 12;  // ceiling on sim ticks per frame; drops surplus to avoid a spiral

const setSpeed = (v) => {
  gameSpeed = v;
  v > 0 && (lastPlaySpeed = v);
  for (const b of speedBar.querySelectorAll('button'))
    b.classList.toggle('active', +b.dataset.speed === v);
};
speedBar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  b && setSpeed(+b.dataset.speed);
});
// Space toggles pause/resume (ignored while typing in the seed box).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.target.tagName === 'INPUT') return;
  e.preventDefault();
  setSpeed(gameSpeed === 0 ? lastPlaySpeed : 0);
});

const randomSeed = () => Math.floor(Math.random() * 1e9).toString(36);

// The seed drives terrain + spawns, so a given seed reproduces the whole battle.
// Take it from ?seed= if present, else start from a random one.
let seedText = new URLSearchParams(location.search).get('seed') ?? randomSeed();
seedInput.value = seedText;

// Generate the world (incl. terrain grids) before the renderer bakes terrain.
world.init(hashSeed(seedText));

const renderer = Renderer.create(canvas);
const camera = Camera.create(WORLD_W, WORLD_H, renderer.width, renderer.height);
const input = Input.create(canvas, camera, world);

window.addEventListener('resize', () => {
  Renderer.resize(renderer);
  Camera.setViewport(camera, renderer.width, renderer.height);
});

// Rebuild the battle from the seed box: reseed the sim and re-bake the terrain.
// Stash the seed in the URL so a reload (or shared link) reproduces the map.
const regenerate = (text) => {
  seedText = text.trim() || randomSeed();
  seedInput.value = seedText;
  world.init(hashSeed(seedText));
  Renderer.buildTerrain(renderer);
  history.replaceState(null, '', `?seed=${encodeURIComponent(seedText)}`);
};

document.getElementById('seedbar').addEventListener('submit', (e) => {
  e.preventDefault();
  regenerate(seedInput.value);
  seedInput.blur();
});
document.getElementById('rand').addEventListener('click', () => regenerate(randomSeed()));

let last = performance.now();
let acc = 0;
let fps = 0;
let simMs = 0;

const frame = (now) => {
  const dt = Math.min(now - last, 250); // avoid spiral-of-death after a tab stall
  last = now;
  acc += dt * gameSpeed;                 // game speed scales how fast sim-time builds up

  input.update(dt / 1000);               // camera still pans/zooms while paused

  const t0 = performance.now();
  let steps = 0;
  while (acc >= TICK_MS && steps < MAX_STEPS) {
    world.step(TICK_S);
    acc -= TICK_MS;
    steps++;
  }
  steps === MAX_STEPS && (acc = 0);      // fell behind (slow frame / high speed): drop the backlog
  simMs = performance.now() - t0;

  Renderer.render(renderer, acc / TICK_MS, camera, input.getSelectionBox());

  fps += (1000 / Math.max(dt, 1) - fps) * 0.1;
  const s = world.getStats();
  const sel = world.getSelectionCounts();
  hud.textContent =
    `silver ${s.team0}   red ${s.team1}\n` +
    `fps    ${fps.toFixed(0)}   zoom ${camera.zoom.toFixed(2)}\n` +
    `sim    ${simMs.toFixed(1)}ms   speed ${gameSpeed === 0 ? 'paused' : gameSpeed + '×'}\n` +
    `selected ${sel.total}   inf ${sel.pike}  arch ${sel.archer}  cav ${sel.knight}\n` +
    `left-drag: select   left-click: move   right-drag/WASD: pan   wheel: zoom   space: pause`;

  requestAnimationFrame(frame);
};

requestAnimationFrame(frame);
