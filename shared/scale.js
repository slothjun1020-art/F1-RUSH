// The one place to change how big the world is compared to the cars.
// Server and browser both import this, so they always agree.
//
// The cars themselves are NOT scaled (CAR.length / CAR.width stay put). Only the track grows, and
// everything that is measured in track units follows automatically: sample spacing, kerbs, runoff
// and guardrails, top speed and acceleration, the grid, trees, hills, the start gantry, camera distance.

export const SCALE = {
  length: 2,     // lap length multiplier (1 = the original size)
  width: 1.5,    // road width multiplier
  // Fine tuning on top of the automatic speed scale (> 1 = faster cars = shorter laps). 0.72 keeps the
  // bot's lap times at 19-38 s on the ten circuits, the same spread they had before the world was enlarged.
  speedTrim: 0.72,
};

// Cars must cover a longer lap in about the same time, so speeds and accelerations follow the lap length.
export const SPEED_SCALE = SCALE.length * SCALE.speedTrim;

// The car keeps its size on screen but the road is wider and faster, so the chase camera backs off a
// little (square root: it does not need to grow as much as the road).
export const CAMERA_SCALE = Math.sqrt(SCALE.width);
