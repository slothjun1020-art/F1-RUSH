// Keyboard input: arrows or WASD to drive, R to put the car back on the track,
// 3/4 (top row or numpad) to shift the sequential gearbox down/up when gear mode is on.

const keys = new Set();
let steer = 0;
let resetRequested = false;
let gearDownRequested = false;
let gearUpRequested = false;

const DRIVE_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
]);
const GEAR_DOWN_KEYS = new Set(['Digit3', 'Numpad3']);
const GEAR_UP_KEYS = new Set(['Digit4', 'Numpad4']);

export function attachInput(isActive) {
  window.addEventListener('keydown', (e) => {
    if (!isActive()) return;
    if (DRIVE_KEYS.has(e.code) || GEAR_DOWN_KEYS.has(e.code) || GEAR_UP_KEYS.has(e.code)) e.preventDefault();
    if (e.code === 'KeyR' && !e.repeat) resetRequested = true;
    if (GEAR_DOWN_KEYS.has(e.code) && !e.repeat) gearDownRequested = true;
    if (GEAR_UP_KEYS.has(e.code) && !e.repeat) gearUpRequested = true;
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
}

export function readInput(dt) {
  const left = keys.has('ArrowLeft') || keys.has('KeyA');
  const right = keys.has('ArrowRight') || keys.has('KeyD');
  const target = (right ? 1 : 0) - (left ? 1 : 0);
  // Ease the steering so tapping a key doesn't snap the wheel.
  steer += (target - steer) * Math.min(1, dt * 9);
  return {
    throttle: keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0,
    brake: keys.has('ArrowDown') || keys.has('KeyS') || keys.has('Space') ? 1 : 0,
    steer,
  };
}

// Let go of every key (used while a dialog is open, so the car doesn't keep steering on its own).
export function clearInput() {
  keys.clear();
  steer = 0;
  gearDownRequested = false;
  gearUpRequested = false;
}

// Same effect as pressing R; used by the on-screen reset button.
export function requestReset() {
  resetRequested = true;
}

export function consumeReset() {
  const r = resetRequested;
  resetRequested = false;
  return r;
}

// { down, up }: whether a downshift/upshift was requested since the last call (edge-triggered, so
// holding the key does not spam shifts).
export function consumeGearShift() {
  const shift = { down: gearDownRequested, up: gearUpRequested };
  gearDownRequested = false;
  gearUpRequested = false;
  return shift;
}
