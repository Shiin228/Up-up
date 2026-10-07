// ---------------------------------------------------------------------------
// UP UP — every tuning number lives here.
//
// Units: world distances are in internal pixels (the canvas is 180x320),
// time is in seconds, speeds in px/s, accelerations in px/s².
// ---------------------------------------------------------------------------

/**
 * The view is always VIEW_H px tall (lower = more zoomed in). Its width
 * follows the screen's aspect ratio
 * (from VIEW_W on phones up to MAX_VIEW_W on ultra-wide monitors) and is
 * fixed for the length of a run.
 */
export const VIEW_W = 128;
export const MAX_VIEW_W = 720;
export const VIEW_H = 240;

/** Fixed simulation step (seconds). 120 Hz keeps collisions tight. */
export const STEP = 1 / 120;
/** Never simulate more than this much time in one animation frame. */
export const MAX_FRAME_TIME = 0.25;

/** World pixels per displayed meter. */
export const PX_PER_METER = 10;

export const PHYSICS = {
  gravity: 600,
  maxFallSpeed: 420,
  /** Launch speed of a tap jump vs. a fully charged jump. */
  jumpMinVelocity: 140,
  jumpMaxVelocity: 330,
  /** Seconds of holding needed to reach a full charge. */
  chargeTime: 0.65,
  /** Horizontal air drag (fraction of vx removed per second). */
  airDrag: 0.8,
  /** Hard cap on horizontal speed (jetpack + wind). */
  maxHorizontalSpeed: 100,
};

export const JETPACK = {
  /** Sideways acceleration while thrusting. */
  thrust: 380,
  fuelCapacity: 100,
  /** Fuel used per second of thrust (100 / 90 ≈ 1.1 s of thrust per tank). */
  drainPerSecond: 90,
  // Fuel never refills on its own — only canisters add fuel.
  /** Below this fraction the fuel bar flashes. */
  lowFuelFraction: 0.25,
  /** Fuel given by a canister pickup. */
  pickupRefill: 80,
};

/** The screen keeps rising; touching the bottom edge ends the run. */
export const AUTO_SCROLL = {
  /** Rising speed (px/s) at the start and at max difficulty. */
  speed: [5, 14] as const,
  /** Distance from the bottom edge at which the danger warning starts. */
  warnDistance: 40,
};

export const PLAYER = {
  width: 8,
  height: 10,
};

export const PLATFORM = {
  thickness: 6,
  /** Seconds a crumbling platform survives after being landed on. */
  crumbleTime: 1.0,
  /** Platforms keep this far from the side walls. */
  wallMargin: 3,
};

/** Difficulty is a 0..1 value derived from height. */
export const DIFFICULTY = {
  /** d = 1 - exp(-meters / scaleMeters) → ~0.04 @10m, ~0.37 @100m, ~0.74 @300m. */
  scaleMeters: 220,
  /** Hard cap so the game stays fair forever. */
  cap: 0.92,
};

/** Values are [easy, hard] pairs interpolated by difficulty. */
export const GENERATION = {
  chunkHeight: 320,
  /** Milliseconds per frame spent generating ahead (unless platforms are about to be needed). */
  frameBudgetMs: 3,
  /** Generate this many px above the top of the screen. */
  generateAhead: 480,
  /** Delete chunks once they are this far below the bottom of the screen. */
  deleteBelow: 120,

  platformWidthMin: [26, 14] as const,
  platformWidthMax: [40, 22] as const,
  /** Crumbling platforms are this much wider than normal ones. */
  crumbleExtraWidth: 8,
  /** Chance that a row gets extra side platforms next to the main one (more on wide screens). */
  extraPlatformChance: [0.8, 0.55] as const,
  /** Side platforms spawn within this many px of the main one. */
  extraPlatformReach: 90,
  /** One guaranteed route per this many px of screen width (1 on phones, 3 at 16:9). */
  routeSpacing: 200,
  gapMin: [24, 50] as const,
  gapMax: [40, 70] as const,
  /** Max horizontal offset of the next platform's center. */
  horizontalSpread: [40, 110] as const,
  /**
   * How much of the farthest *reachable* sideways offset the next platform
   * uses (a random value between min and max). Higher = more jetpack needed.
   */
  lateralDemandMin: [0.4, 0.5] as const,
  lateralDemandMax: [0.9, 0.95] as const,

  crumbleStartMeters: 25,
  crumbleChance: [0.12, 0.42] as const,

  // --- Fuel economy (fuel never regenerates) -----------------------------
  // The generator tracks the fuel a careful player is guaranteed to have and
  // only asks each jump for what is left, so the climb is always possible.
  /** Chance that a jump is a "sideways jump" placed far enough out to need the jetpack. */
  fuelLegChance: [0.35, 0.45] as const,
  /** Most fuel a jetpack jump may require. */
  fuelLegBudget: [16, 24] as const,
  /** Most fuel any other jump may require (tiny aim corrections). */
  freeLegBudget: 10,
  /** Extra fuel counted on top of the cheapest way to make each jump. */
  fuelSlack: 1,
  /** Side platforms may need this much more fuel than the main route to rejoin it. */
  extraPlatformFuel: 24,
  /** When guaranteed fuel would drop below this fraction, a refuel can is placed. */
  refuelThreshold: 0.3,
  /** Rare bonus canisters floating in the air (per jump). */
  bonusPickupChance: [0.06, 0.025] as const,

  // --- Reachability (keeps every level beatable) -------------------------
  /** Shrinks the computed horizontal reach (0.8 = use 80% of it). */
  reachSafety: 0.8,
  /** The jump apex must clear a platform by at least this many px. */
  apexMargin: 10,
  /** The player's center must land at least this far inside a platform. */
  landingInset: 3,
  /** Narrowest landing spot (px) the guaranteed route may demand. */
  minLandingWindow: 10,
  /** Seconds kept back for reaction when jumping off a crumbling platform. */
  crumbleReactionTime: 0.18,
  attemptsPerPlatform: 40,
};

export const WIND = {
  startMeters: 55,
  /** Chance per 200px slot that a wind band appears. */
  chance: [0.3, 0.75] as const,
  strength: [90, 205] as const,
  /** Wind never exceeds this fraction of jetpack thrust. */
  maxFractionOfThrust: 0.55,
  heightMin: 60,
  heightMax: 140,
  /** Vertical gap between bands (> max jump height, so a jump meets at most one). */
  minSeparation: 110,
};

export const CAMERA = {
  /** Player is kept at this fraction of the screen height from the bottom. */
  anchor: 0.5,
  /** Higher = snappier follow. */
  smoothing: 5,
  startOffset: -24,
};

export const FEEL = {
  /** Landing speed that counts as a hard landing. */
  hardLandingSpeed: 300,
  shakeMax: 3,
  shakeDecay: 9,
  /** Shake multiplier when prefers-reduced-motion is on. */
  reducedMotionShake: 0,
  squashRecover: 12,
  maxParticles: 400,
};

export const THEMES = {
  /** A new sky every this many meters (sunset → night → space). */
  metersPerTheme: 100,
  /** Meters over which skies dither into each other. */
  transitionMeters: 20,
};

export const STORAGE_KEYS = {
  best: "upup.best",
  muted: "upup.muted",
  musicOff: "upup.musicOff",
};
