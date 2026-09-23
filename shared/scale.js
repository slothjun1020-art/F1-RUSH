// The one place to change how big the world is compared to the cars.
// Server and browser both import this, so they always agree.
//
// The cars themselves are NOT scaled (CAR.length / CAR.width stay put). Only the track grows, and
// everything that is measured in track units follows automatically: sample spacing, kerbs, runoff
// and guardrails, top speed and acceleration, the grid, trees, hills, the start gantry, camera distance.

export const SCALE = {
  length: 2.4,   // lap length multiplier (1 = the original size)
  width: 2.25,   // road width multiplier
  // Fine tuning on top of the automatic speed scale (> 1 = faster cars = shorter laps). Retuned whenever
  // length/width change so the bot's lap times stay in the 15-45 s band checked by tests/tracks.test.js.
  speedTrim: 0.72,
};

// Cars must cover a longer lap in about the same time, so speeds and accelerations follow the lap length.
export const SPEED_SCALE = SCALE.length * SCALE.speedTrim;

// The car keeps its size on screen but the road is wider and faster, so the chase camera backs off a
// little (square root: it does not need to grow as much as the road).
export const CAMERA_SCALE = Math.sqrt(SCALE.width);
