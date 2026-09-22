// The original top-down 2D renderer, moved out of game.js unchanged so it can sit next to the 3D one.

import { CAR } from '/shared/physics.js';
import { CAMERA_SCALE } from '/shared/scale.js';
import { drawWorld, drawCar, drawLabel } from './render.js';

export class Renderer2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = null;
  }

  setTrack() {
    this.cam = null;
  }

  snap() {
    this.cam = null;
  }

  render({ dt, track, car, me, others }) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    if (!this.cam) this.cam = { x: car.x, y: car.y };

    const speedRatio = Math.min(1, Math.abs(car.v) / CAR.maxSpeed);
    // The car keeps its size, the road is wider and faster: zoom out a little so the same amount of road shows.
    const scale = Math.max(0.3, Math.min(1.3, (H / (760 * CAMERA_SCALE)) * (1 - 0.18 * speedRatio)));
    const lx = car.x + Math.cos(car.a) * car.v * 0.22;
    const ly = car.y + Math.sin(car.a) * car.v * 0.22;
    const follow = 1 - Math.exp(-dt * 7);
    this.cam.x += (lx - this.cam.x) * follow;
    this.cam.y += (ly - this.cam.y) * follow;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#244f31';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const k = dpr * scale;
    ctx.setTransform(k, 0, 0, k, (canvas.width / 2) - this.cam.x * k, (canvas.height / 2) - this.cam.y * k);
    const view = {
      x0: this.cam.x - W / 2 / scale - 40,
      y0: this.cam.y - H / 2 / scale - 40,
      x1: this.cam.x + W / 2 / scale + 40,
      y1: this.cam.y + H / 2 / scale + 40,
    };
    drawWorld(ctx, track, view);

    const fontScale = 1 / scale;
    for (const o of others) {
      drawCar(ctx, o.x, o.y, o.a, o.color);
      drawLabel(ctx, o.nick, o.x, o.y - 34 * fontScale, o.color, false, 14 * fontScale);
    }
    drawCar(ctx, car.x, car.y, car.a, me?.color ?? '#e10600');
    drawLabel(ctx, me?.nick ?? '', car.x, car.y - 34 * fontScale, '#fff', true, 14 * fontScale);
  }
}
