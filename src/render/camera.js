// A viewport onto the fixed world space. Holds a top-left world position (x, y)
// and a zoom factor; screen = (world - cam) * zoom. Clamping keeps the view
// inside the world and stops you from zooming out past "whole world visible".

import { MAX_ZOOM } from '../config.js';

export class Camera {
  constructor(worldW, worldH, viewW, viewH) {
    this.worldW = worldW;
    this.worldH = worldH;
    this.viewW = viewW;
    this.viewH = viewH;
    this.zoom = 1;
    // Start centered on the world.
    this.x = (worldW - viewW) / 2;
    this.y = (worldH - viewH) / 2;
    this.clamp();
  }

  setViewport(viewW, viewH) {
    this.viewW = viewW;
    this.viewH = viewH;
    this.clamp();
  }

  // Visible extent measured in world units.
  get viewWorldW() { return this.viewW / this.zoom; }
  get viewWorldH() { return this.viewH / this.zoom; }

  screenToWorldX(sx) { return this.x + sx / this.zoom; }
  screenToWorldY(sy) { return this.y + sy / this.zoom; }
  worldToScreenX(wx) { return (wx - this.x) * this.zoom; }
  worldToScreenY(wy) { return (wy - this.y) * this.zoom; }

  // Pan by a screen-space delta (e.g. a mouse drag), in the natural direction.
  panByScreen(dx, dy) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  // Pan by a world-space delta (e.g. keyboard, already scaled by dt).
  panByWorld(dx, dy) {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  // Zoom by a multiplicative factor while keeping the world point under the
  // cursor pinned to the same screen pixel.
  zoomAt(factor, sx, sy) {
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);
    this.zoom *= factor;
    this.clampZoom();
    this.x = wx - sx / this.zoom;
    this.y = wy - sy / this.zoom;
    this.clamp();
  }

  clampZoom() {
    // Min zoom = enough that the view never exceeds the world in either axis.
    const minZoom = Math.max(this.viewW / this.worldW, this.viewH / this.worldH);
    if (this.zoom < minZoom) this.zoom = minZoom;
    if (this.zoom > MAX_ZOOM) this.zoom = MAX_ZOOM;
  }

  clamp() {
    this.clampZoom();
    const maxX = this.worldW - this.viewWorldW;
    const maxY = this.worldH - this.viewWorldH;
    this.x = maxX <= 0 ? 0 : Math.min(Math.max(this.x, 0), maxX);
    this.y = maxY <= 0 ? 0 : Math.min(Math.max(this.y, 0), maxY);
  }
}
