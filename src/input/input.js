// Player command + camera control layer.
//   left click        → order your (team 0) army to a world point
//   right-drag / MMB   → pan the camera
//   wheel              → zoom toward the cursor
//   W/A/S/D or arrows  → pan the camera

const PAN_KEYS_SPEED = 900; // world units/sec at zoom 1

export class Input {
  constructor(canvas, cam, world) {
    this.cam = cam;
    this.keys = new Set();
    let dragging = false;
    let lastX = 0, lastY = 0;

    const localPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('mousedown', (e) => {
      const p = localPos(e);
      if (e.button === 0) {
        // Left click: command, in world coordinates.
        world.setManualTarget(cam.screenToWorldX(p.x), cam.screenToWorldY(p.y));
      } else if (e.button === 1 || e.button === 2) {
        dragging = true;
        lastX = p.x;
        lastY = p.y;
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const p = localPos(e);
      cam.panByScreen(p.x - lastX, p.y - lastY);
      lastX = p.x;
      lastY = p.y;
    });

    window.addEventListener('mouseup', () => { dragging = false; });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = localPos(e);
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      cam.zoomAt(factor, p.x, p.y);
    }, { passive: false });

    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  // Apply held-key panning; call once per rendered frame.
  update(dt) {
    const k = this.keys;
    let dx = 0, dy = 0;
    if (k.has('a') || k.has('arrowleft')) dx -= 1;
    if (k.has('d') || k.has('arrowright')) dx += 1;
    if (k.has('w') || k.has('arrowup')) dy -= 1;
    if (k.has('s') || k.has('arrowdown')) dy += 1;
    if (dx || dy) {
      const speed = PAN_KEYS_SPEED * dt;
      this.cam.panByWorld(dx * speed, dy * speed);
    }
  }
}
