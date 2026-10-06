// Keyboard input: arrows or WASD to drive, R to put the car back on the track,
// Shift to upshift the sequential gearbox when gear mode is on. There is no manual downshift key —
// downshifting is automatic, tied to braking (see game.js's update()).

const keys = new Set();
let steer = 0;
let resetRequested = false;
let gearUpRequested = false;

const DRIVE_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
]);

export function attachInput(isActive) {
  window.addEventListener('keydown', (e) => {
    if (!isActive()) return;
    // e.key (not e.code) for Shift: it reads 'Shift' for either the left or right key, so both always
    // work the same way, unlike e.code's ShiftLeft/ShiftRight split, which some keyboard layouts and
    // OS/browser combinations don't report consistently for the right-hand key.
    const isShift = e.key === 'Shift';
    if (DRIVE_KEYS.has(e.code) || isShift) e.preventDefault();
    if (e.code === 'KeyR' && !e.repeat) resetRequested = true;
    if (isShift && !e.repeat) gearUpRequested = true;
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

// Whether an upshift (Shift) was requested since the last call — edge-triggered, so holding the key
// does not spam shifts. There is no downshift counterpart; see game.js's update() for the automatic,
// braking-triggered downshift instead.
export function consumeGearUp() {
  const up = gearUpRequested;
  gearUpRequested = false;
  return up;
}
