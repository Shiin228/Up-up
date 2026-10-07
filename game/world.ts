import {
  DIFFICULTY,
  GENERATION,
  JETPACK,
  PHYSICS,
  PLATFORM,
  PLAYER,
  PX_PER_METER,
  STEP,
  THEMES,
  WIND,
} from "./config";
import { jumpVelocity, stepAirborne, type Body } from "./player";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlatformKind = "solid" | "crumble";

export interface Platform {
  id: number;
  /** Left edge. */
  x: number;
  /** Top surface (world y grows upward). */
  y: number;
  w: number;
  kind: PlatformKind;
  /** Sky theme index at this height (picks the tile style). */
  theme: number;
  state: "intact" | "shaking" | "broken";
  /** Seconds left before a shaking platform breaks. */
  timer: number;
}

export interface Pickup {
  /** Center x. */
  x: number;
  /** Bottom y. */
  y: number;
  floating: boolean;
  /** Set when the can sits on a platform: landing anywhere on it collects the can. */
  platformId: number | null;
  taken: boolean;
  phase: number;
}

export interface WindZone {
  y0: number;
  y1: number;
  dir: 1 | -1;
  /** Acceleration in px/s². */
  strength: number;
  seed: number;
}

export interface Chunk {
  index: number;
  y0: number;
  /** Highest y of anything inside the chunk (platforms may overshoot y0 + chunkHeight). */
  top: number;
  platforms: Platform[];
  pickups: Pickup[];
}

/** A range of player center x positions. */
export type Span = [number, number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mulberry32: tiny, fast, seedable PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ramp = (pair: readonly [number, number], d: number) => lerp(pair[0], pair[1], d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function difficultyAt(meters: number): number {
  const d = 1 - Math.exp(-Math.max(0, meters) / DIFFICULTY.scaleMeters);
  return Math.min(DIFFICULTY.cap, d);
}

export function themeIndexAt(meters: number): number {
  return clamp(Math.floor(meters / THEMES.metersPerTheme), 0, 2);
}

// ---------------------------------------------------------------------------
// Reachability — simulates the real physics to decide if a jump is possible
// ---------------------------------------------------------------------------

const HALF_W = PLAYER.width / 2;
const CAP = JETPACK.fuelCapacity;
const CHARGE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1];

/** Charge the player can build on a crumbling platform before it breaks. */
const CRUMBLE_MAX_CHARGE = clamp(
  (PLATFORM.crumbleTime - GENERATION.crumbleReactionTime) / PHYSICS.chargeTime,
  0,
  1,
);

const legCache = new Map<string, number | null>();

/**
 * Horizontal displacement when the player's feet come back down through
 * height `dy` after a jump with launch speed `v0`, thrusting `thrustDir`
 * until `fuel` runs out, under a constant wind. null = can't get that high.
 */
function simulateLeg(v0: number, dy: number, thrustDir: number, wind: number, fuel: number): number | null {
  const key = `${v0}|${dy}|${thrustDir}|${wind}|${fuel}`;
  const cached = legCache.get(key);
  if (cached !== undefined) return cached;

  const b: Body = { x: 0, y: 0, vx: 0, vy: v0 };
  let maxY = 0;
  let result: number | null = null;
  let f = fuel;
  for (let i = 0; i < 2000; i++) {
    let dir = 0;
    if (thrustDir !== 0 && f > 0) {
      dir = thrustDir;
      f -= JETPACK.drainPerSecond * STEP;
    }
    stepAirborne(b, dir, wind, STEP);
    if (b.y > maxY) maxY = b.y;
    if (b.vy <= 0 && b.y <= dy) {
      result = maxY >= dy + GENERATION.apexMargin ? b.x : null;
      break;
    }
  }
  if (legCache.size > 40000) legCache.clear();
  legCache.set(key, result);
  return result;
}

/**
 * The guaranteed range [lo, hi] of horizontal displacement for one launch
 * speed. Wind exposure in-game is partial (only inside the band), so we take
 * the worse of "no wind" and "wind for the whole flight" on each side.
 */
function displacementRange(v0: number, dy: number, wind: number, fuel: number): Span | null {
  const lo0 = simulateLeg(v0, dy, -1, 0, fuel);
  const hi0 = simulateLeg(v0, dy, 1, 0, fuel);
  if (lo0 === null || hi0 === null) return null;
  let lo = lo0;
  let hi = hi0;
  if (wind !== 0) {
    const loW = simulateLeg(v0, dy, -1, wind, fuel);
    const hiW = simulateLeg(v0, dy, 1, wind, fuel);
    if (loW === null || hiW === null) return null;
    lo = Math.max(lo0, loW);
    hi = Math.min(hi0, hiW);
    if (lo > hi) return null;
  }
  const mid = (lo + hi) / 2;
  const half = ((hi - lo) / 2) * GENERATION.reachSafety;
  return [mid - half, mid + half];
}

/** Displacement ranges for every allowed charge level. */
function legRanges(dy: number, wind: number, fuel: number, maxCharge: number): Span[] {
  const dyQ = Math.ceil(dy);
  const windQ = Math.sign(wind) * Math.ceil(Math.abs(wind) / 5) * 5;
  const fuelQ = Math.floor(fuel);
  if (fuelQ < 0) return [];
  const ranges: Span[] = [];
  for (const c of CHARGE_STEPS) {
    if (c > maxCharge + 1e-6) continue;
    const r = displacementRange(jumpVelocity(c), dyQ, windQ, fuelQ);
    if (r) ranges.push(r);
  }
  return ranges;
}

/** Can a player standing anywhere in `from` land somewhere in `target`? */
function canHit(from: Span, target: Span, ranges: Span[]): boolean {
  const starts = from[1] - from[0] < 1 ? [from[0]] : [from[0], (from[0] + from[1]) / 2, from[1]];
  return starts.every((s) => ranges.some(([lo, hi]) => s + lo <= target[1] && s + hi >= target[0]));
}

/**
 * The widest landing window on `to` that a player standing anywhere in
 * `from` can always hit, or null. Landing inside it keeps the climb possible.
 */
function landingWindow(from: Span, to: Platform, ranges: Span[], worldW: number): Span | null {
  if (ranges.length === 0) return null;
  const inset = Math.min(GENERATION.landingInset, to.w / 2 - 1);
  const t0 = clamp(to.x + inset, HALF_W, worldW - HALF_W);
  const t1 = clamp(to.x + to.w - inset, HALF_W, worldW - HALF_W);
  if (t1 < t0) return null;
  const full = t1 - t0;
  const minW = Math.min(full, GENERATION.minLandingWindow);
  const widths: number[] = [];
  for (let w = full; w > minW; w -= 4) widths.push(w);
  widths.push(minW);
  for (const w of widths) {
    for (let w0 = t0; w0 + w <= t1 + 1e-6; w0 += 2) {
      if (canHit(from, [w0, w0 + w], ranges)) return [w0, w0 + w];
    }
  }
  return null;
}

/** Highest the feet can rise with a full jump (from the real simulation). */
function computeMaxApex(): number {
  const b: Body = { x: 0, y: 0, vx: 0, vy: PHYSICS.jumpMaxVelocity };
  let maxY = 0;
  while (b.vy > 0) {
    stepAirborne(b, 0, 0, STEP);
    maxY = Math.max(maxY, b.y);
  }
  return maxY;
}

export const MAX_JUMP_HEIGHT = computeMaxApex();

/** A planned jump on a guaranteed route: fuel it may need and where to land. */
interface Leg {
  fuel: number;
  window: Span;
}

/**
 * Generator state for one guaranteed route: its last platform, where on it the
 * player must stand, the fuel a careful player is guaranteed to have there,
 * crumbling platforms in a row, side platforms awaiting validation, and the
 * x position the route drifts toward.
 */
interface Route {
  last: Platform;
  window: Span;
  fuel: number;
  crumbleRun: number;
  pendingExtras: Platform[];
  lane: number;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export class World {
  readonly seed: number;
  /** Playfield width in px (follows the screen's aspect ratio). */
  readonly width: number;
  chunks: Chunk[] = [];
  winds: WindZone[] = [];

  private rng: () => number;
  private windRng: () => number;
  private nextId = 1;
  private windCursor = 0;
  /** Guaranteed routes up the level (more of them on wide screens). */
  private routes: Route[];

  readonly ground: Platform;

  constructor(seed: number, width: number) {
    this.seed = seed;
    this.width = Math.round(width);
    this.rng = mulberry32(seed);
    this.windRng = mulberry32(seed ^ 0x9e3779b9);
    this.ground = this.makePlatform(0, 0, this.width, "solid");
    this.chunks.push({ index: 0, y0: 0, top: 0, platforms: [this.ground], pickups: [] });
    // An odd number of evenly spaced lanes, so the middle one starts where the player does.
    // The ground is one long platform, so the other lanes start a short hop away.
    const count = 2 * Math.max(0, Math.round((this.width / GENERATION.routeSpacing - 1) / 2)) + 1;
    this.routes = Array.from({ length: count }, (_, i) => {
      const lane = ((i + 0.5) * this.width) / count;
      return { last: this.ground, window: [lane - 2, lane + 2] as Span, fuel: CAP, crumbleRun: 0, pendingExtras: [], lane };
    });
  }

  // --- Queries -----------------------------------------------------------

  *platforms(): Generator<Platform> {
    for (const c of this.chunks) for (const p of c.platforms) yield p;
  }

  *pickups(): Generator<Pickup> {
    for (const c of this.chunks) for (const p of c.pickups) yield p;
  }

  /** Signed horizontal wind acceleration at world height y. */
  windAt(y: number): number {
    for (const z of this.winds) {
      if (y >= z.y0 && y <= z.y1) return z.dir * z.strength;
    }
    return 0;
  }

  // --- Lifecycle ---------------------------------------------------------

  /**
   * Generate the level ahead of the camera (a few rows per frame, so there
   * are no hitches) and delete chunks far below it.
   */
  update(cameraY: number, viewH: number): void {
    const needTop = cameraY + viewH + GENERATION.generateAhead;
    const urgentTop = cameraY + viewH + 64;
    const start = performance.now();
    while (this.generatedTop() < needTop) {
      this.generateRow();
      if (this.generatedTop() >= urgentTop && performance.now() - start > GENERATION.frameBudgetMs) break;
    }

    const cutoff = cameraY - GENERATION.deleteBelow;
    if (this.chunks.length > 1 && this.chunks[0].top < cutoff) {
      this.chunks = this.chunks.filter((c) => c.top >= cutoff);
    }
    if (this.winds.length && this.winds[0].y1 < cutoff) {
      this.winds = this.winds.filter((z) => z.y1 >= cutoff);
    }
  }

  /** Advance crumbling platforms; returns the ones that broke this step. */
  updatePlatforms(dt: number): Platform[] {
    const broken: Platform[] = [];
    for (const p of this.platforms()) {
      if (p.state !== "shaking") continue;
      p.timer -= dt;
      if (p.timer <= 0) {
        p.state = "broken";
        broken.push(p);
      }
    }
    return broken;
  }

  // --- Generation --------------------------------------------------------

  private makePlatform(x: number, y: number, w: number, kind: PlatformKind): Platform {
    return {
      id: this.nextId++,
      x,
      y,
      w,
      kind,
      theme: themeIndexAt(y / PX_PER_METER),
      state: "intact",
      timer: 0,
    };
  }

  private lowestRoute(): Route {
    return this.routes.reduce((a, b) => (b.last.y < a.last.y ? b : a));
  }

  /** Height up to which every route has been generated. */
  private generatedTop(): number {
    return this.lowestRoute().last.y;
  }

  /** Advance the lowest route by one row, filing it into its chunk. */
  private generateRow(): void {
    const route = this.lowestRoute();
    const ch = GENERATION.chunkHeight;
    const index = Math.floor(route.last.y / ch);
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk.index < index) {
      chunk = { index, y0: index * ch, top: index * ch, platforms: [], pickups: [] };
      this.chunks.push(chunk);
    }
    // Wind is generated further ahead than platforms so every jump knows its wind.
    this.ensureWind((index + 2) * ch);

    const row = this.nextRow(route);
    chunk.platforms.push(...row.platforms);
    chunk.pickups.push(...row.pickups);
    for (const p of row.platforms) chunk.top = Math.max(chunk.top, p.y);
    for (const p of row.pickups) chunk.top = Math.max(chunk.top, p.y + 8);
  }

  private ensureWind(upTo: number): void {
    const startY = WIND.startMeters * PX_PER_METER;
    while (this.windCursor < upTo) {
      if (this.windCursor < startY) {
        this.windCursor = startY;
        continue;
      }
      const r = this.windRng;
      const d = difficultyAt(this.windCursor / PX_PER_METER);
      if (r() < ramp(WIND.chance, d)) {
        const h = Math.round(lerp(WIND.heightMin, WIND.heightMax, r()));
        const strength = Math.min(
          ramp(WIND.strength, d) * (0.8 + 0.2 * r()),
          JETPACK.thrust * WIND.maxFractionOfThrust,
        );
        const zone: WindZone = {
          y0: this.windCursor,
          y1: this.windCursor + h,
          dir: r() < 0.5 ? -1 : 1,
          strength: Math.round(strength),
          seed: Math.floor(r() * 10000),
        };
        this.winds.push(zone);
        this.windCursor = zone.y1 + WIND.minSeparation + Math.round(r() * 80);
      } else {
        this.windCursor += 200;
      }
    }
  }

  /** Wind affecting a jump that starts on `p` (bands are spaced so at most one applies). */
  private windForLeg(p: Platform): number {
    const lo = p.y;
    const hi = p.y + MAX_JUMP_HEIGHT + PLAYER.height;
    let wind = 0;
    for (const z of this.winds) {
      if (z.y1 >= lo && z.y0 <= hi && z.strength > Math.abs(wind)) wind = z.dir * z.strength;
    }
    return wind;
  }

  private ranges(from: Platform, to: { y: number }, fuel: number): Span[] {
    const maxCharge = from.kind === "crumble" ? CRUMBLE_MAX_CHARGE : 1;
    return legRanges(to.y - from.y, this.windForLeg(from), fuel, maxCharge);
  }

  /** Where a player standing anywhere on `p` can be. */
  private fullSpan(p: Platform): Span {
    const lo = HALF_W;
    const hi = this.width - HALF_W;
    return [clamp(p.x - HALF_W + 1, lo, hi), clamp(p.x + p.w + HALF_W - 1, lo, hi)];
  }

  private reachable(from: Platform, fromSpan: Span, to: Platform, fuel: number): boolean {
    return landingWindow(fromSpan, to, this.ranges(from, to, fuel), this.width) !== null;
  }

  /** The cheapest version of a jump (plus a little slack), or null if `maxFuel` is not enough. */
  private cheapestLeg(from: Platform, fromSpan: Span, to: Platform, maxFuel: number): Leg | null {
    if (maxFuel < 0) return null;
    for (let f = 0; ; f = Math.min(maxFuel, f + 2)) {
      if (landingWindow(fromSpan, to, this.ranges(from, to, f), this.width)) {
        const fuel = Math.min(maxFuel, f + GENERATION.fuelSlack);
        return { fuel, window: landingWindow(fromSpan, to, this.ranges(from, to, fuel), this.width)! };
      }
      if (f >= maxFuel) return null;
    }
  }

  /** A short, wide, solid "rescue" step above `from`, if one is reachable. */
  private safeStepFrom(from: Platform, fromSpan: Span, fuel: number): { platform: Platform; leg: Leg } | null {
    const cx = (fromSpan[0] + fromSpan[1]) / 2;
    for (const dy of [14, 20, 28, 36]) {
      for (const w of [40, 64]) {
        const x = clamp(Math.round(cx - w / 2), PLATFORM.wallMargin, this.width - PLATFORM.wallMargin - w);
        const cand: Platform = { ...from, id: -1, x, y: from.y + dy, w, kind: "solid", state: "intact", timer: 0 };
        const leg = this.cheapestLeg(from, fromSpan, cand, fuel);
        if (leg) return { platform: cand, leg };
      }
    }
    return null;
  }

  /** Would a platform here overlap (or nearly touch) one already generated? */
  private overlapsExisting(p: { x: number; y: number; w: number }): boolean {
    const near = (o: Platform) => Math.abs(o.y - p.y) < 12 && p.x < o.x + o.w + 6 && p.x + p.w + 6 > o.x;
    for (let i = Math.max(0, this.chunks.length - 2); i < this.chunks.length; i++) {
      for (const o of this.chunks[i].platforms) if (o !== this.ground && near(o)) return true;
    }
    return this.routes.some((r) => r.pendingExtras.some(near));
  }

  /** Fuel guaranteed after a jump, and whether a refuel can goes on the landing platform. */
  private afterLeg(fuelLeft: number, crumbleAfterCrumble: boolean): { fuel: number; refuel: boolean } {
    const refuel = crumbleAfterCrumble || fuelLeft < GENERATION.refuelThreshold * CAP;
    return { fuel: refuel ? Math.min(CAP, fuelLeft + JETPACK.pickupRefill) : fuelLeft, refuel };
  }

  /**
   * Generates the next row: one platform on the guaranteed route plus the
   * previous row's side platforms that turned out to have a way onward.
   */
  private nextRow(route: Route): { platforms: Platform[]; pickups: Pickup[] } {
    const prev = route.last;
    const span = route.window;
    const fuel = route.fuel;
    const r = this.rng;
    const W = this.width;
    const meters = prev.y / PX_PER_METER;
    const d = difficultyAt(meters);
    const prevCx = (span[0] + span[1]) / 2;
    const margin = PLATFORM.wallMargin;

    // How much fuel this jump may ask for. Most jumps need almost none.
    // "Sideways" jumps are placed far out and need the jetpack. Jumps through
    // wind also get a real budget (drift can't be aimed without fuel), but are
    // placed wherever is cheapest. Only the fuel actually needed is charged.
    const sideways = r() < ramp(GENERATION.fuelLegChance, d);
    const windy = this.windForLeg(prev) !== 0;
    const budget = Math.min(fuel, sideways || windy ? ramp(GENERATION.fuelLegBudget, d) : GENERATION.freeLegBudget);

    const wantCrumble =
      meters >= GENERATION.crumbleStartMeters && route.crumbleRun < 2 && r() < ramp(GENERATION.crumbleChance, d);
    // Drift toward this route's lane; otherwise lean away from the nearest wall.
    const towardLane = route.lane - prevCx;
    const pRight = Math.abs(towardLane) > 60 ? (towardLane > 0 ? 0.8 : 0.2) : 1 - prevCx / W;

    let next: Platform | null = null;
    let leg: Leg | null = null;
    const attempts = GENERATION.attemptsPerPlatform;
    for (let a = 0; a < attempts && !next; a++) {
      const relax = a / attempts;
      const kind: PlatformKind = wantCrumble && a < attempts * 0.6 ? "crumble" : "solid";
      const extra = kind === "crumble" ? GENERATION.crumbleExtraWidth : 0;
      const wMin = ramp(GENERATION.platformWidthMin, d);
      const wMax = ramp(GENERATION.platformWidthMax, d);
      const w = Math.round(Math.min(W - 2 * margin, lerp(wMin, wMax, r()) + extra + relax * 24));
      const gap = lerp(ramp(GENERATION.gapMin, d), ramp(GENERATION.gapMax, d), r()) * (1 - 0.6 * relax);
      const y = prev.y + Math.max(10, Math.round(gap));
      const side = r() < pRight ? 1 : -1;
      const spread = ramp(GENERATION.horizontalSpread, d) * (1 - relax);
      const at = (offset: number): Platform => {
        const x = Math.round(clamp(prevCx + side * offset - w / 2, margin, W - margin - w));
        return { id: -1, x, y, w, kind, theme: 0, state: "intact", timer: 0 };
      };

      // Farthest offset in this direction that is still provably reachable…
      let maxOffset = -1;
      for (let off = spread; off > 0; off -= 6) {
        if (this.reachable(prev, span, at(off), budget)) {
          maxOffset = off;
          break;
        }
      }
      if (maxOffset < 0 && this.reachable(prev, span, at(0), budget)) maxOffset = 0;
      if (maxOffset < 0) continue;

      // …then ask for a share of it that grows with difficulty.
      const demand = lerp(ramp(GENERATION.lateralDemandMin, d), ramp(GENERATION.lateralDemandMax, d), r());
      let cand = at(maxOffset * demand);
      if (!this.reachable(prev, span, cand, budget)) cand = at(maxOffset);
      if (a < attempts * 0.75 && this.overlapsExisting(cand)) continue;
      let candLeg = this.cheapestLeg(prev, span, cand, budget);
      if (!sideways && windy) {
        // Ride the wind: pick the offset that costs the least fuel.
        for (let off = 0; off <= maxOffset; off += 6) {
          const c = at(off);
          const l = this.cheapestLeg(prev, span, c, candLeg ? candLeg.fuel - 1 : budget);
          if (l) {
            cand = c;
            candLeg = l;
          }
        }
      }
      if (!candLeg) continue;

      if (kind === "crumble") {
        // A crumbling platform must always have a way off it with the fuel left.
        const arrival = this.afterLeg(fuel - candLeg.fuel, prev.kind === "crumble").fuel;
        if (!this.safeStepFrom(cand, candLeg.window, arrival)) continue;
      }
      next = this.makePlatform(cand.x, cand.y, cand.w, kind);
      leg = candLeg;
    }

    if (!next || !leg) {
      const safe = this.safeStepFrom(prev, span, fuel);
      if (safe) {
        next = this.makePlatform(safe.platform.x, safe.platform.y, safe.platform.w, "solid");
        leg = safe.leg;
      } else {
        // Full-width ledge: always reachable, even with an empty tank.
        next = this.makePlatform(margin, prev.y + 12, W - 2 * margin, "solid");
        leg = { fuel: 0, window: landingWindow(span, next, this.ranges(prev, next, 0), W) ?? this.fullSpan(next) };
      }
    }

    const step = next;
    const stepLeg = leg;
    const after = this.afterLeg(fuel - stepLeg.fuel, step.kind === "crumble" && prev.kind === "crumble");

    // Side platforms from the previous row stay only if the route is reachable from them.
    const extraFuel = Math.min(fuel, stepLeg.fuel + GENERATION.extraPlatformFuel);
    const platforms = route.pendingExtras.filter((e) =>
      canHit(this.fullSpan(e), stepLeg.window, this.ranges(e, step, extraFuel)),
    );
    platforms.push(step);

    const pickups: Pickup[] = [];
    if (after.refuel) {
      // Guaranteed refuel: sits on the route platform and is collected on landing.
      const x = (stepLeg.window[0] + stepLeg.window[1]) / 2;
      pickups.push({ x, y: step.y, floating: false, taken: false, phase: r() * 6, platformId: step.id });
      route.pendingExtras = [];
    } else {
      route.pendingExtras = this.makeExtras(step, prev, d);
      if (r() < ramp(GENERATION.bonusPickupChance, d)) {
        const t = 0.35 + r() * 0.4;
        const x = clamp(lerp(prevCx, step.x + step.w / 2, t), 6, W - 6);
        const y = prev.y + 20 + r() * Math.min(40, step.y - prev.y + 10);
        pickups.push({ x, y, floating: true, taken: false, phase: r() * 6, platformId: null });
      }
    }

    route.fuel = after.fuel;
    route.window = stepLeg.window;
    route.crumbleRun = step.kind === "crumble" ? route.crumbleRun + 1 : 0;
    route.last = step;
    return { platforms, pickups };
  }

  /** 1–2 small side platforms at roughly the same height as `row`. */
  private makeExtras(row: Platform, prev: Platform, d: number): Platform[] {
    const r = this.rng;
    const out: Platform[] = [];
    if (r() >= ramp(GENERATION.extraPlatformChance, d)) return out;
    const count = r() < 0.4 ? 2 : 1;
    const margin = PLATFORM.wallMargin;
    const rowCx = row.x + row.w / 2;
    const reach = GENERATION.extraPlatformReach;
    const crumbleOk = row.y / PX_PER_METER >= GENERATION.crumbleStartMeters;
    for (let k = 0; k < count; k++) {
      for (let tries = 0; tries < 8; tries++) {
        const kind: PlatformKind =
          crumbleOk && r() < ramp(GENERATION.crumbleChance, d) * 0.5 ? "crumble" : "solid";
        const w = Math.round(
          lerp(ramp(GENERATION.platformWidthMin, d), ramp(GENERATION.platformWidthMax, d), r()) +
            (kind === "crumble" ? GENERATION.crumbleExtraWidth : 0),
        );
        const lo = Math.max(margin, rowCx - reach - w / 2);
        const hi = Math.min(this.width - margin - w, rowCx + reach - w / 2);
        const x = Math.round(lo + r() * Math.max(0, hi - lo));
        const y = row.y + Math.round(-6 + r() * 16);
        if (y <= prev.y + 10) continue;
        const clash = [row, ...out].some((o) => x < o.x + o.w + 10 && x + w + 10 > o.x);
        if (clash || this.overlapsExisting({ x, y, w })) continue;
        out.push(this.makePlatform(x, y, w, kind));
        break;
      }
    }
    return out;
  }
}
