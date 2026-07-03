// Wires the pieces together: a fixed-timestep sim loop decoupled from rendering.
// Real time accumulates; the sim advances in fixed TICK_MS steps (deterministic,
// stable); the renderer draws at display rate and interpolates between the last
// two sim states so motion stays smooth even though the sim ticks at ~33Hz.

import { Renderer } from './render/renderer.js';
import { Camera } from './render/camera.js';
import * as world from './sim/world.js';
import { Input } from './input/input.js';
import * as U from './sim/units.js';
import { hashSeed } from './sim/rng.js';
import { TICK_MS, WORLD_W, WORLD_H } from './config.js';

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const seedInput = document.getElementById('seed');

// The seed drives terrain + spawns, so a given seed reproduces the whole battle.
// Take it from ?seed= if present, else start from a random one.
let seedText = new URLSearchParams(location.search).get('seed');
if (seedText === null) seedText = randomSeed();
seedInput.value = seedText;

// Generate the world (incl. terrain grids) before the renderer bakes terrain.
world.init(hashSeed(seedText));

const renderer = new Renderer(canvas);
const camera = new Camera(WORLD_W, WORLD_H, renderer.width, renderer.height);
const input = new Input(canvas, camera, world);

window.addEventListener('resize', () => {
  renderer.resize();
  camera.setViewport(renderer.width, renderer.height);
});

// Rebuild the battle from the seed box: reseed the sim and re-bake the terrain.
// Stash the seed in the URL so a reload (or shared link) reproduces the map.
function regenerate(text) {
  seedText = text.trim() || randomSeed();
  seedInput.value = seedText;
  world.init(hashSeed(seedText));
  renderer.buildTerrain();
  history.replaceState(null, '', `?seed=${encodeURIComponent(seedText)}`);
}

function randomSeed() {
  return Math.floor(Math.random() * 1e9).toString(36);
}

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

function frame(now) {
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250; // avoid spiral-of-death after a tab stall
  acc += dt;

  input.update(dt / 1000);

  const t0 = performance.now();
  while (acc >= TICK_MS) {
    world.step(TICK_MS / 1000);
    acc -= TICK_MS;
  }
  simMs = performance.now() - t0;

  renderer.render(acc / TICK_MS, camera);

  fps += (1000 / Math.max(dt, 1) - fps) * 0.1;
  const s = world.getStats();
  hud.textContent =
    `silver ${s.team0}   red ${s.team1}\n` +
    `fps    ${fps.toFixed(0)}   zoom ${camera.zoom.toFixed(2)}\n` +
    `sim    ${simMs.toFixed(1)}ms\n` +
    `left-click: order army   right-drag/WASD: pan   wheel: zoom`;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
