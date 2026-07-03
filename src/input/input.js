// Player command layer. For the slice: click redirects your (team 0) army.

export function initInput(canvas, world) {
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    world.setManualTarget(e.clientX - rect.left, e.clientY - rect.top);
  });
}
