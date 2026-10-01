// Pure logic for replaying a saved best-lap "ghost" car (see server/ghosts.js for how the trail is
// recorded server-side, and public/game.js for how this is wired into the per-frame render loop).
// No DOM or Three.js here, so it can be unit-tested directly, like public/interp.js.

const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// path: [[t, x, y, a], ...] sorted by t ascending, t in [0, duration] (duration = that lap's time).
// elapsedMs: how long the ghost has been "driving" since the race started. A solo race is usually more
// laps than the one that was recorded, so the ghost just loops the same lap for as long as the race runs
// — elapsedMs wraps modulo the recorded lap's duration rather than stopping at the end of it.
// Returns { x, y, a }, or null if there is no path to replay.
export function ghostPoseAt(path, elapsedMs) {
  if (!path || !path.length) return null;
  const duration = path[path.length - 1][0];
  if (path.length === 1 || duration <= 0) {
    const [, x, y, a] = path[0];
    return { x, y, a };
  }
  const t = ((elapsedMs % duration) + duration) % duration;
  for (let i = path.length - 2; i >= 0; i--) {
    const [pt, px, py, pa] = path[i];
    if (pt <= t) {
      const [qt, qx, qy, qa] = path[i + 1];
      const u = (t - pt) / (qt - pt || 1);
      return {
        x: px + (qx - px) * u,
        y: py + (qy - py) * u,
        a: pa + norm(qa - pa) * u,
      };
    }
  }
  const [, x, y, a] = path[0];
  return { x, y, a };
}
