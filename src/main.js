// Wires the pieces together: a fixed-timestep sim loop decoupled from rendering.
// Real time accumulates; the sim advances in fixed TICK_MS steps (deterministic,
// stable); the renderer draws at display rate and interpolates between the last
// two sim states so motion stays smooth even though the sim ticks at ~33Hz.

import { Renderer } from './render/renderer.js';
import * as world from './sim/world.js';
import { initInput } from './input/input.js';
import * as U from './sim/units.js';
import { TICK_MS } from './config.js';

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const renderer = new Renderer(canvas);

world.init(renderer.width, renderer.height);
initInput(canvas, world);

window.addEventListener('resize', () => {
  renderer.resize();
  world.resize(renderer.width, renderer.height);
});

let last = performance.now();
let acc = 0;
let fps = 0;
let simMs = 0;

function frame(now) {
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250; // avoid spiral-of-death after a tab stall
  acc += dt;

  const t0 = performance.now();
  while (acc >= TICK_MS) {
    world.step(TICK_MS / 1000);
    acc -= TICK_MS;
  }
  simMs = performance.now() - t0;

  renderer.render(acc / TICK_MS);

  fps += (1000 / Math.max(dt, 1) - fps) * 0.1;
  const s = world.getStats();
  hud.textContent =
    `silver ${s.team0}   red ${s.team1}\n` +
    `fps    ${fps.toFixed(0)}\n` +
    `sim    ${simMs.toFixed(1)}ms\n` +
    `click: move your (silver) army`;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
