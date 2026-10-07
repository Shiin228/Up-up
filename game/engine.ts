import {
  AUTO_SCROLL,
  MAX_VIEW_W,
  CAMERA,
  FEEL,
  JETPACK,
  MAX_FRAME_TIME,
  PLATFORM,
  PLAYER,
  PX_PER_METER,
  STEP,
  STORAGE_KEYS,
  THEMES,
  VIEW_H,
  VIEW_W,
} from "./config";
import { Sound } from "./audio";
import { Input, type PointerRole } from "./input";
import { Player } from "./player";
import {
  bakeSprite,
  CHEVRON,
  CLOUD_A,
  CLOUD_B,
  DEBRIS_COLORS,
  drawText,
  FUEL_CAN,
  mirrorSprite,
  PALETTE,
  PALETTE_U32,
  PLAYER_AIR,
  PLAYER_STAND,
  textWidth,
  TILE_CRUMBLE,
  TILE_SOLID,
} from "./sprites";
import { difficultyAt, randomSeed, World, type Pickup, type Platform } from "./world";

export type Screen = "title" | "playing" | "paused" | "over";

export interface UiState {
  screen: Screen;
  /** Final (or current) height in meters. */
  height: number;
  best: number;
  newBest: boolean;
  seed: number;
  muted: boolean;
  musicOn: boolean;
  /** Canvas width in game px (height is always VIEW_H). */
  viewW: number;
}

export interface EngineOptions {
  onUi(state: UiState): void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  /** Colors over the particle's life, first = young. */
  colors: readonly number[];
  gravity: number;
  size: number;
}

interface Sprites {
  stand: [HTMLCanvasElement, HTMLCanvasElement];
  air: [HTMLCanvasElement, HTMLCanvasElement];
  can: HTMLCanvasElement;
  chevron: [HTMLCanvasElement, HTMLCanvasElement];
  tiles: HTMLCanvasElement[];
  crumble: HTMLCanvasElement;
  clouds: Record<"sunsetFar" | "sunsetNear" | "night", HTMLCanvasElement[]>;
  windPattern: CanvasPattern | null;
}

// --- Sky themes: color bands top → bottom ----------------------------------

const SKY_BANDS: readonly (readonly number[])[] = [
  [1, 2, 2, 8, 14, 9, 15], // sunset
  [0, 1, 1, 1, 2], // night
  [0, 0, 0, 0, 1], // space
];

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

interface SkyRows {
  lo: Uint8Array;
  hi: Uint8Array;
  mix: Float32Array;
}

function buildSkyRows(bands: readonly number[]): SkyRows {
  const lo = new Uint8Array(VIEW_H);
  const hi = new Uint8Array(VIEW_H);
  const mix = new Float32Array(VIEW_H);
  const n = bands.length - 1;
  for (let y = 0; y < VIEW_H; y++) {
    const p = (y / (VIEW_H - 1)) * n;
    const i = Math.min(n - 1, Math.floor(p));
    const f = p - i;
    lo[y] = bands[i];
    hi[y] = bands[i + 1];
    // Solid bands with a dithered seam between them.
    mix[y] = f < 0.65 ? 0 : (f - 0.65) / 0.35;
  }
  return { lo, hi, mix };
}

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mod = (a: number, m: number) => ((a % m) + m) % m;

function loadNumber(key: string): number {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function saveNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable (private mode, quota) */
  }
}

// ---------------------------------------------------------------------------

export class Engine {
  readonly input: Input;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sound: Sound;
  private readonly opts: EngineOptions;
  private readonly sprites: Sprites;
  private readonly canvas: HTMLCanvasElement;
  private sky!: ImageData;
  private skyU32!: Uint32Array;
  /** Canvas width in px (follows the window's aspect ratio). */
  private viewW = VIEW_W;
  private readonly skyRows: SkyRows[];
  private readonly reducedMotion: boolean;
  private readonly fixedSeed: number | null;

  private world!: World;
  private player = new Player();
  private screen: Screen = "title";
  private camY = 0;
  private prevCamY = 0;
  private time = 0;
  private acc = 0;
  private lastFrame = 0;
  private raf = 0;
  private particles: Particle[] = [];
  private shake = 0;

  private best: number;
  private runStartBest = 0;
  private savedBest: number;
  private saveTimer = 0;
  private newBest = false;
  private finalHeight = 0;
  private overAt = 0;
  private muted: boolean;
  private musicOn: boolean;

  private hintStage = 0;
  private bannerText = "";
  private bannerUntil = 0;
  private seenCrumble = false;
  private seenWind = false;
  private bestAnnounced = false;
  private chargeBlips = 0;
  private emptyCooldown = 0;
  /** The screen starts rising after the first jump of a run. */
  private scrolling = false;
  private warnCooldown = 0;

  constructor(canvas: HTMLCanvasElement, container: HTMLElement, opts: EngineOptions) {
    this.opts = opts;
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;
    this.resizeCanvas(VIEW_W);

    this.skyRows = SKY_BANDS.map(buildSkyRows);
    this.sprites = this.bakeSprites();

    this.best = Math.floor(loadNumber(STORAGE_KEYS.best));
    this.savedBest = this.best;
    this.muted = loadNumber(STORAGE_KEYS.muted) === 1;
    this.musicOn = loadNumber(STORAGE_KEYS.musicOff) !== 1;
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const seedParam = Number.parseInt(new URLSearchParams(window.location.search).get("seed") ?? "", 10);
    this.fixedSeed = Number.isFinite(seedParam) ? Math.abs(seedParam) : null;

    this.sound = new Sound(this.muted, this.musicOn);
    this.input = new Input(container, {
      onGesture: () => this.sound.unlock(),
      onKeyDown: (code) => this.onKey(code),
      classifyPointer: () => this.classifyPointer(),
    });

    this.newRun();
  }

  // --- Public API (used by React) ----------------------------------------

  start(): void {
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("resize", this.onResize);
    this.emitUi();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onResize);
    this.input.destroy();
    this.sound.destroy();
    this.persistBest();
  }

  toggleMusic(): void {
    this.sound.unlock();
    this.musicOn = !this.musicOn;
    this.sound.setMusicEnabled(this.musicOn);
    saveNumber(STORAGE_KEYS.musicOff, this.musicOn ? 0 : 1);
    this.emitUi();
  }

  toggleMute(): void {
    this.sound.unlock();
    this.muted = !this.muted;
    this.sound.setMuted(this.muted);
    saveNumber(STORAGE_KEYS.muted, this.muted ? 1 : 0);
    if (!this.muted) this.sound.click();
    this.emitUi();
  }

  toggleFullscreen(): void {
    try {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void document.documentElement.requestFullscreen?.().catch(() => {});
    } catch {
      /* fullscreen not available (e.g. iPhone Safari) */
    }
  }

  togglePause(): void {
    this.sound.unlock();
    if (this.screen === "playing") {
      this.screen = "paused";
      this.sound.thrust(false);
      this.input.reset();
      this.persistBest();
      this.emitUi();
    } else if (this.screen === "paused") {
      this.screen = "playing";
      this.lastFrame = 0;
      this.acc = 0;
      this.emitUi();
    }
  }

  // --- Run lifecycle -----------------------------------------------------

  private newRun(): void {
    const seed = this.fixedSeed ?? randomSeed();
    const width = this.screenWidth();
    this.world = new World(seed, width);
    this.resizeCanvas(width);
    this.player.reset(width / 2, this.world.ground);
    this.camY = this.prevCamY = CAMERA.startOffset;
    this.world.update(this.camY, VIEW_H);
    this.particles = [];
    this.shake = 0;
    this.runStartBest = this.best;
    this.newBest = false;
    this.bestAnnounced = false;
    this.finalHeight = 0;
    this.bannerUntil = 0;
    this.chargeBlips = 0;
    this.scrolling = false;
  }

  private beginPlay(): void {
    this.screen = "playing";
    this.lastFrame = 0;
    this.acc = 0;
    this.emitUi();
  }

  private restart(): void {
    this.newRun();
    this.hintStage = Math.max(this.hintStage, 2);
    this.beginPlay();
  }

  private gameOver(): void {
    this.screen = "over";
    this.sound.thrust(false);
    this.sound.gameOver();
    this.finalHeight = Math.floor(this.player.maxY / PX_PER_METER);
    this.newBest = this.finalHeight > this.runStartBest;
    if (this.finalHeight > this.best) this.best = this.finalHeight;
    this.persistBest();
    this.overAt = this.time;
    this.input.reset();
    this.emitUi();
  }

  private persistBest(): void {
    if (this.best > this.savedBest) {
      saveNumber(STORAGE_KEYS.best, this.best);
      this.savedBest = this.best;
    }
  }

  private emitUi(): void {
    this.opts.onUi({
      screen: this.screen,
      height: this.screen === "over" ? this.finalHeight : Math.floor(this.player.maxY / PX_PER_METER),
      best: this.best,
      newBest: this.newBest,
      seed: this.world.seed,
      muted: this.muted,
      musicOn: this.musicOn,
      viewW: this.viewW,
    });
  }

  // --- Screen size -------------------------------------------------------

  /** View width that fills the window at the fixed VIEW_H height. */
  private screenWidth(): number {
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    return clamp(Math.round((VIEW_H * vw) / Math.max(1, vh)), VIEW_W, MAX_VIEW_W);
  }

  /** The canvas is never narrower than the current world. */
  private resizeCanvas(width: number): void {
    const w = Math.max(width, this.world?.width ?? 0);
    if (w === this.viewW && this.sky) return;
    this.viewW = w;
    this.canvas.width = w;
    this.canvas.height = VIEW_H;
    this.ctx.imageSmoothingEnabled = false;
    this.sky = this.ctx.createImageData(w, VIEW_H);
    this.skyU32 = new Uint32Array(this.sky.data.buffer);
  }

  private onResize = (): void => {
    if (this.screen === "title") {
      // Nothing is at stake yet: rebuild the level for the new shape.
      this.newRun();
    } else {
      // Mid-run the level keeps its width; extra space shows sky around it.
      this.resizeCanvas(this.screenWidth());
    }
    this.emitUi();
  };

  // --- Input routing -----------------------------------------------------

  private onKey(code: string): void {
    switch (code) {
      case "Space":
        if (this.screen === "title") this.beginPlay();
        else if (this.screen === "over" && this.time - this.overAt > 0.6) this.restart();
        break;
      case "Enter":
      case "KeyR":
        if (this.screen === "over") this.restart();
        else if (this.screen === "title" && code === "Enter") this.beginPlay();
        break;
      case "KeyP":
      case "Escape":
        this.togglePause();
        break;
      case "KeyN":
        this.toggleMusic();
        break;
      case "KeyM":
        this.toggleMute();
        break;
      case "KeyF":
        this.toggleFullscreen();
        break;
    }
  }

  private classifyPointer(): PointerRole {
    switch (this.screen) {
      case "title":
        this.beginPlay();
        return "jump";
      case "paused":
        this.togglePause();
        return "none";
      case "over":
        if (this.time - this.overAt > 0.6) this.restart();
        return "none";
      default:
        return this.player.ground ? "jump" : "steer";
    }
  }

  private onVisibility = (): void => {
    if (document.hidden && this.screen === "playing") this.togglePause();
  };

  private onBlur = (): void => {
    if (this.screen === "playing") this.togglePause();
  };

  // --- Main loop ---------------------------------------------------------

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(MAX_FRAME_TIME, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;

    if (this.screen === "playing") {
      this.acc += dt;
      while (this.acc >= STEP) {
        this.prevCamY = this.camY;
        this.tick(STEP);
        this.acc -= STEP;
        if (this.screen !== "playing") {
          this.acc = 0;
          break;
        }
      }
    } else if (this.screen !== "paused") {
      // Title / game over: keep the scenery and particles alive.
      this.time += dt;
      this.updateParticles(dt);
      this.shake = Math.max(0, this.shake - FEEL.shakeDecay * dt);
      this.prevCamY = this.camY;
    }

    // Music: layers follow the sky theme; quieter while paused or after a fall.
    const theme = this.themeAt(this.camY);
    const mode = this.screen === "playing" ? "play" : this.screen === "title" ? "title" : "duck";
    this.sound.music(mode, theme.t < 0.5 ? theme.a : theme.b);

    const alpha = this.screen === "playing" ? this.acc / STEP : 1;
    this.render(alpha);
  };

  private tick(dt: number): void {
    this.time += dt;
    const p = this.player;
    const input = this.input;
    p.update(dt, { jumpHeld: input.jumpHeld, left: input.left, right: input.right }, this.world);

    for (const ev of p.events) {
      switch (ev.type) {
        case "chargeStart":
          this.chargeBlips = 0;
          this.sound.charge(0);
          break;
        case "jump":
          this.sound.jump(ev.charge);
          this.burst(p.x, p.y, 6, [7, 6], 30, 20);
          if (this.hintStage === 0) this.hintStage = 1;
          if (!this.scrolling) {
            this.scrolling = true;
            this.banner("SCREEN RISING! KEEP CLIMBING", 2.5);
          }
          break;
        case "land":
          this.onLand(ev.speed, ev.platform);
          break;
        case "fallOff":
          break;
      }
    }
    p.events.length = 0;

    // Charging blips rise with the charge level.
    if (p.charging) {
      const step = Math.floor(p.charge * 8);
      if (step > this.chargeBlips) {
        this.chargeBlips = step;
        this.sound.charge(p.charge);
      }
    }

    // Jetpack.
    this.sound.thrust(p.thrustDir !== 0);
    if (p.thrustDir !== 0) {
      if (this.hintStage === 1) this.hintStage = 2;
      for (let i = 0; i < 2; i++) {
        this.spawn({
          x: p.x - p.thrustDir * 4,
          y: p.y + 3 + Math.random() * 2,
          vx: -p.thrustDir * (40 + Math.random() * 40) + p.vx * 0.3,
          vy: -15 + Math.random() * 25,
          life: 0.25 + Math.random() * 0.15,
          maxLife: 0.4,
          colors: [10, 9, 8, 5],
          gravity: -20,
          size: 1,
        });
      }
    } else if (!p.ground && (input.left || input.right) && p.fuel <= 0) {
      this.emptyCooldown -= dt;
      if (this.emptyCooldown <= 0) {
        this.emptyCooldown = 0.35;
        this.sound.empty();
        this.burst(p.x - p.facing * 4, p.y + 4, 3, [5, 6], 15, 10);
      }
    }

    // Crumbling platforms.
    for (const broken of this.world.updatePlatforms(dt)) {
      this.sound.crumble();
      for (const can of this.world.pickups()) if (can.platformId === broken.id) can.taken = true;
      for (let i = 0; i < Math.max(6, broken.w / 2); i++) {
        this.spawn({
          x: broken.x + Math.random() * broken.w,
          y: broken.y - Math.random() * PLATFORM.thickness,
          vx: (Math.random() - 0.5) * 50,
          vy: Math.random() * 50,
          life: 0.8 + Math.random() * 0.6,
          maxLife: 1.4,
          colors: [DEBRIS_COLORS.crumble[i % 3]],
          gravity: 500,
          size: Math.random() < 0.4 ? 2 : 1,
        });
      }
    }
    if (Math.random() < 0.3) {
      for (const pl of this.world.platforms()) {
        if (pl.state !== "shaking") continue;
        this.spawn({
          x: pl.x + Math.random() * pl.w,
          y: pl.y - PLATFORM.thickness,
          vx: 0,
          vy: -10,
          life: 0.5,
          maxLife: 0.5,
          colors: [15, 4],
          gravity: 300,
          size: 1,
        });
      }
    }

    // Wind announcement.
    if (!this.seenWind && !p.ground && this.world.windAt(p.y + PLAYER.height / 2) !== 0) {
      this.seenWind = true;
      this.banner("WIND! USE JETPACK", 2);
    }

    // Fuel pickups.
    for (const can of this.world.pickups()) {
      if (can.taken) continue;
      if (Math.abs(can.x - p.x) < 7 && p.y < can.y + 8 && p.y + PLAYER.height > can.y) this.collect(can);
    }

    // The screen keeps rising on its own, and also follows the player up.
    if (this.scrolling) {
      const d = difficultyAt(this.camY / PX_PER_METER);
      this.camY += (AUTO_SCROLL.speed[0] + (AUTO_SCROLL.speed[1] - AUTO_SCROLL.speed[0]) * d) * dt;
    }
    const target = p.y - VIEW_H * CAMERA.anchor;
    if (target > this.camY) this.camY += (target - this.camY) * Math.min(1, CAMERA.smoothing * dt);
    this.world.update(this.camY, VIEW_H);

    // Warning beeps when the bottom edge is close.
    this.warnCooldown -= dt;
    if (this.scrolling && p.y - this.camY < AUTO_SCROLL.warnDistance && this.warnCooldown <= 0) {
      this.warnCooldown = 0.45;
      this.sound.warn();
    }

    this.updateParticles(dt);
    this.shake = Math.max(0, this.shake - FEEL.shakeDecay * dt);

    // Best height (saved at most once a second while climbing).
    const meters = Math.floor(p.maxY / PX_PER_METER);
    if (meters > this.best) {
      this.best = meters;
      if (!this.bestAnnounced && this.runStartBest > 0) {
        this.bestAnnounced = true;
        this.banner("NEW BEST!", 1.5);
      }
    }
    this.saveTimer -= dt;
    if (this.saveTimer <= 0) {
      this.saveTimer = 1;
      this.persistBest();
    }

    // Touching the bottom edge of the screen ends the run.
    if (p.y <= this.camY) this.gameOver();
  }

  private collect(can: Pickup): void {
    const p = this.player;
    can.taken = true;
    p.fuel = Math.min(JETPACK.fuelCapacity, p.fuel + JETPACK.pickupRefill);
    this.sound.pickup();
    this.burst(can.x, can.y + 4, 14, [10, 7, 11, 12], 60, 60);
  }

  private onLand(speed: number, platform: Platform): void {
    const p = this.player;
    for (const can of this.world.pickups()) {
      if (!can.taken && can.platformId === platform.id) this.collect(can);
    }
    const intensity = clamp((speed - 100) / 300, 0, 1);
    if (speed > 40) this.sound.land(intensity);
    this.burst(p.x, p.y, 3 + Math.round(intensity * 6), [7, 6], 25 + 40 * intensity, 15);
    if (speed >= FEEL.hardLandingSpeed) {
      const k = this.reducedMotion ? FEEL.reducedMotionShake : 1;
      this.shake = Math.max(this.shake, FEEL.shakeMax * k * clamp(speed / 420, 0.5, 1));
    }
    if (platform.kind === "crumble" && platform.state === "intact") {
      platform.state = "shaking";
      platform.timer = PLATFORM.crumbleTime;
      this.sound.crumbleStart();
      if (!this.seenCrumble) {
        this.seenCrumble = true;
        this.banner("CRUMBLING! JUMP FAST!", 1.6);
      }
    }
  }

  private banner(text: string, seconds: number): void {
    this.bannerText = text;
    this.bannerUntil = this.time + seconds;
  }

  // --- Particles ---------------------------------------------------------

  private spawn(p: Particle): void {
    if (this.particles.length >= FEEL.maxParticles) this.particles.shift();
    this.particles.push(p);
  }

  private burst(x: number, y: number, n: number, colors: readonly number[], speed: number, up: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.abs(Math.sin(a)) * s * 0.6 + up * Math.random(),
        life: 0.3 + Math.random() * 0.3,
        maxLife: 0.6,
        colors: [colors[i % colors.length]],
        gravity: 200,
        size: 1,
      });
    }
  }

  private updateParticles(dt: number): void {
    const list = this.particles;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      q.life -= dt;
      if (q.life <= 0) continue;
      q.vy -= q.gravity * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      list[w++] = q;
    }
    list.length = w;
  }

  // --- Rendering ---------------------------------------------------------

  private bakeSprites(): Sprites {
    const pair = (art: readonly string[], map?: Record<string, number>): [HTMLCanvasElement, HTMLCanvasElement] => {
      const right = bakeSprite(art, map);
      return [right, mirrorSprite(right)];
    };
    const patternCanvas = document.createElement("canvas");
    patternCanvas.width = patternCanvas.height = 4;
    const pctx = patternCanvas.getContext("2d")!;
    pctx.fillStyle = PALETTE[12];
    pctx.fillRect(0, 0, 1, 1);
    return {
      stand: pair(PLAYER_STAND),
      air: pair(PLAYER_AIR),
      can: bakeSprite(FUEL_CAN),
      chevron: pair(CHEVRON, { x: 7 }),
      tiles: TILE_SOLID.map((t) => bakeSprite(t)),
      crumble: bakeSprite(TILE_CRUMBLE),
      clouds: {
        sunsetFar: [bakeSprite(CLOUD_A, { x: 14, y: 2 }), bakeSprite(CLOUD_B, { x: 14, y: 2 })],
        sunsetNear: [bakeSprite(CLOUD_A, { x: 15, y: 14 }), bakeSprite(CLOUD_B, { x: 15, y: 14 })],
        night: [bakeSprite(CLOUD_A, { x: 5, y: 1 }), bakeSprite(CLOUD_B, { x: 5, y: 1 })],
      },
      windPattern: this.ctx.createPattern(patternCanvas, "repeat"),
    };
  }

  /** World y → screen y for the current render camera. */
  private sy(worldY: number, cam: number): number {
    return Math.round(VIEW_H - (worldY - cam));
  }

  private render(alpha: number): void {
    const ctx = this.ctx;
    const cam = this.prevCamY + (this.camY - this.prevCamY) * alpha;
    const camR = Math.round(cam);

    const themePos = this.themeAt(cam);
    this.drawSky(themePos);
    this.drawBackdrop(camR, themePos);

    ctx.save();
    ctx.translate(this.worldX(), 0);
    if (this.shake > 0.2) {
      ctx.translate(Math.round((Math.random() * 2 - 1) * this.shake), Math.round((Math.random() * 2 - 1) * this.shake));
    }
    this.drawWind(camR);
    this.drawPlatforms(camR);
    this.drawPickups(camR);
    this.drawParticles(camR);
    if (this.screen !== "over") this.drawPlayer(camR, alpha);
    ctx.restore();
    this.drawSideWalls();

    if (this.screen === "playing" || this.screen === "paused") {
      this.drawDangerEdge();
      this.drawHud();
    }
  }

  /** Left edge of the world inside the canvas (non-zero only if the window grew mid-run). */
  private worldX(): number {
    return Math.floor((this.viewW - this.world.width) / 2);
  }

  /** Brick tower walls filling any space beside the world. */
  private drawSideWalls(): void {
    const ox = this.worldX();
    if (ox <= 0) return;
    const ctx = this.ctx;
    const cam = Math.round(this.camY);
    const right = ox + this.world.width;
    for (const [x0, x1] of [[0, ox], [right, this.viewW]]) {
      ctx.fillStyle = PALETTE[1];
      ctx.fillRect(x0, 0, x1 - x0, VIEW_H);
      ctx.fillStyle = PALETTE[0];
      for (let y = -mod(cam, 8); y < VIEW_H; y += 8) {
        ctx.fillRect(x0, y, x1 - x0, 1);
        const row = Math.floor((y + cam) / 8);
        for (let x = x0 + (row % 2 ? 0 : 6); x < x1; x += 12) ctx.fillRect(x, y, 1, 8);
      }
    }
    ctx.fillStyle = PALETTE[5];
    ctx.fillRect(ox - 1, 0, 1, VIEW_H);
    ctx.fillRect(right, 0, 1, VIEW_H);
  }

  /** Current theme pair and blend factor, based on the camera's height. */
  private themeAt(cam: number): { a: number; b: number; t: number } {
    const meters = (cam + VIEW_H / 2) / PX_PER_METER;
    const per = THEMES.metersPerTheme;
    const a = clamp(Math.floor(meters / per), 0, SKY_BANDS.length - 1);
    if (a >= SKY_BANDS.length - 1) return { a, b: a, t: 0 };
    const into = meters - ((a + 1) * per - THEMES.transitionMeters);
    if (into <= 0) return { a, b: a, t: 0 };
    return { a, b: a + 1, t: clamp(into / THEMES.transitionMeters, 0, 1) };
  }

  /**
   * Dithered gradient sky, written straight into an ImageData buffer. A new
   * theme wipes down from the top with a dithered seam.
   */
  private drawSky({ a, b, t }: { a: number; b: number; t: number }): void {
    const out = this.skyU32;
    const W = this.viewW;
    const A = this.skyRows[a];
    const B = this.skyRows[b];
    const seam = 24;
    const edge = t * (VIEW_H + seam);
    for (let y = 0; y < VIEW_H; y++) {
      const rowBase = y * W;
      const by = (y & 3) * 4;
      const by2 = ((y + 2) & 3) * 4;
      const share = clamp((edge - y) / seam, 0, 1);
      for (let x = 0; x < W; x++) {
        const rows = share > BAYER4[by + (x & 3)] ? B : A;
        const m = rows.mix[y];
        const c = m > BAYER4[by2 + ((x + 1) & 3)] ? rows.hi[y] : rows.lo[y];
        out[rowBase + x] = PALETTE_U32[c];
      }
    }
    this.ctx.putImageData(this.sky, 0, 0);
  }

  private drawBackdrop(cam: number, { a, b, t }: { a: number; b: number; t: number }): void {
    const theme = t < 0.5 ? a : b;
    const ctx = this.ctx;
    const themeStartCam = theme * THEMES.metersPerTheme * PX_PER_METER;

    if (theme === 0) {
      // Setting sun that sinks as you climb.
      const sunY = VIEW_H - 46 + (cam - CAMERA.startOffset) * 0.06;
      const sunX = Math.round(this.viewW * 0.67);
      this.pixelCircle(sunX, sunY, 22, 9);
      this.pixelCircle(sunX, sunY, 18, 10);
      this.drawStars(cam, 0.05, 0.03, [15, 14], 1);
      this.drawClouds(cam, 0.18, this.sprites.clouds.sunsetFar, 2, 3);
      this.drawClouds(cam, 0.4, this.sprites.clouds.sunsetNear, 5, 4);
    } else if (theme === 1) {
      const moonY = 54 + (cam - themeStartCam) * 0.03;
      const moonX = this.viewW - 44;
      this.pixelCircle(moonX, moonY, 11, 7);
      this.pixelCircle(moonX + 4, moonY - 3, 3, 6);
      this.pixelCircle(moonX - 5, moonY + 4, 2, 6);
      this.drawStars(cam, 0.06, 0.22, [7, 6, 13], 2);
      this.drawStars(cam, 0.15, 0.12, [6, 13], 3);
      this.drawClouds(cam, 0.35, this.sprites.clouds.night, 4, 6);
    } else {
      const py = 90 + (cam - themeStartCam) * 0.02;
      // Ringed planet.
      ctx.fillStyle = PALETTE[9];
      ctx.fillRect(14, Math.round(py), 52, 1);
      this.pixelCircle(40, py, 15, 13);
      this.pixelCircle(44, py - 4, 9, 14);
      ctx.fillStyle = PALETTE[9];
      ctx.fillRect(10, Math.round(py) + 1, 60, 2);
      ctx.fillStyle = PALETTE[4];
      ctx.fillRect(18, Math.round(py) + 3, 44, 1);
      this.drawStars(cam, 0.04, 0.3, [7, 12, 6], 7);
      this.drawStars(cam, 0.12, 0.2, [7, 14, 13], 8);
      this.drawStars(cam, 0.25, 0.08, [7, 10], 9);
    }
  }

  private pixelCircle(cx: number, cy: number, r: number, color: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE[color];
    const icy = Math.round(cy);
    for (let dy = -r; dy <= r; dy++) {
      const y = icy + dy;
      if (y < 0 || y >= VIEW_H) continue;
      const half = Math.floor(Math.sqrt(r * r - dy * dy));
      ctx.fillRect(cx - half, y, half * 2 + 1, 1);
    }
  }

  private drawStars(cam: number, parallax: number, density: number, colors: readonly number[], layer: number): void {
    const ctx = this.ctx;
    const cell = 12;
    const offset = cam * parallax;
    const r0 = Math.floor(offset / cell);
    const r1 = Math.floor((offset + VIEW_H) / cell);
    const cols = Math.ceil(this.viewW / cell);
    for (let row = r0; row <= r1; row++) {
      for (let col = 0; col < cols; col++) {
        const h = hash(row, col, layer);
        if (h >= density) continue;
        const x = col * cell + Math.floor(hash(row, col, layer + 100) * cell);
        const vy = row * cell + Math.floor(hash(row, col, layer + 200) * cell);
        const y = Math.round(VIEW_H - (vy - offset));
        const twinkle = Math.sin(this.time * 2.5 + h * 300) > 0.6;
        const ci = twinkle ? 0 : 1 + (Math.floor(h * 1000) % Math.max(1, colors.length - 1));
        ctx.fillStyle = PALETTE[colors[Math.min(ci, colors.length - 1)]];
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  private drawClouds(cam: number, parallax: number, sprites: HTMLCanvasElement[], speed: number, layer: number): void {
    const ctx = this.ctx;
    const cellH = 70;
    const offset = cam * parallax;
    const r0 = Math.floor(offset / cellH) - 1;
    const r1 = Math.floor((offset + VIEW_H) / cellH) + 1;
    const span = this.viewW + 40;
    for (let row = r0; row <= r1; row++) {
      const h = hash(row, 7, layer);
      if (h > 0.7) continue;
      const sprite = sprites[hash(row, 8, layer) < 0.5 ? 0 : 1];
      const dir = hash(row, 9, layer) < 0.5 ? -1 : 1;
      const x = Math.round(mod(hash(row, 10, layer) * span + this.time * speed * dir, span) - 20);
      const vy = row * cellH + hash(row, 11, layer) * cellH * 0.6;
      const y = Math.round(VIEW_H - (vy - offset));
      ctx.drawImage(sprite, x, y);
    }
  }

  private drawWind(cam: number): void {
    const ctx = this.ctx;
    for (const z of this.world.winds) {
      const top = this.sy(z.y1, cam);
      const bottom = this.sy(z.y0, cam);
      if (bottom < 0 || top > VIEW_H) continue;
      const h = bottom - top;

      // Faint dithered tint, anchored to the world so it doesn't shimmer.
      if (this.sprites.windPattern) {
        const shift = mod(cam, 4);
        ctx.save();
        ctx.translate(0, shift);
        ctx.fillStyle = this.sprites.windPattern;
        ctx.fillRect(0, top - shift, this.world.width, h);
        ctx.restore();
      }

      // Moving dashed borders.
      ctx.fillStyle = PALETTE[12];
      const dashShift = mod(this.time * (20 + z.strength * 0.2) * z.dir, 6);
      for (let x = -6; x < this.world.width + 6; x += 6) {
        const dx = Math.round(x + dashShift);
        ctx.fillRect(dx, top, 3, 1);
        ctx.fillRect(dx, bottom - 1, 3, 1);
      }

      // Streaks and chevrons blowing with the wind.
      const count = Math.max(3, Math.floor(h / 9));
      const span = this.world.width + 40;
      const chevron = this.sprites.chevron[z.dir > 0 ? 0 : 1];
      for (let i = 0; i < count; i++) {
        const r1 = hash(z.seed, i, 1);
        const r2 = hash(z.seed, i, 2);
        const r3 = hash(z.seed, i, 3);
        const len = 4 + Math.floor(r2 * 8);
        const speed = (25 + z.strength * 0.6) * (0.6 + 0.4 * r3);
        const x = Math.round(mod(r1 * span + this.time * speed * z.dir, span) - 20);
        const y = Math.round(top + 3 + hash(z.seed, i, 4) * Math.max(1, h - 8));
        if (i % 3 === 0) {
          ctx.drawImage(chevron, z.dir > 0 ? x + len + 1 : x - 4, y - 2);
        }
        ctx.fillStyle = PALETTE[i % 2 ? 7 : 6];
        ctx.fillRect(x, y, len, 1);
      }
    }
  }

  private drawPlatforms(cam: number): void {
    const ctx = this.ctx;
    const th = PLATFORM.thickness;
    for (const p of this.world.platforms()) {
      if (p.state === "broken") continue;
      let x = p.x;
      let y = this.sy(p.y, cam);
      if (y > VIEW_H || y + th < 0) continue;
      if (p.state === "shaking") {
        const urgency = 1 - p.timer / PLATFORM.crumbleTime;
        const j = Math.floor(this.time * 40) + p.id;
        x += (j % 2 ? 1 : -1) * (urgency > 0.5 ? 1 : j % 4 === 0 ? 1 : 0);
        y += urgency > 0.6 && j % 3 === 0 ? 1 : 0;
      }
      const tile = p.kind === "crumble" ? this.sprites.crumble : this.sprites.tiles[p.theme];
      for (let tx = 0; tx < p.w; tx += 8) {
        const cw = Math.min(8, p.w - tx);
        ctx.drawImage(tile, 0, 0, cw, th, x + tx, y, cw, th);
      }
      // Dark underside so platforms read against any sky.
      ctx.fillStyle = PALETTE[0];
      ctx.fillRect(x + 1, y + th, p.w - 2, 1);
    }
  }

  private drawPickups(cam: number): void {
    const ctx = this.ctx;
    for (const can of this.world.pickups()) {
      if (can.taken) continue;
      const bob = can.floating ? Math.round(Math.sin(this.time * 3 + can.phase) * 1.5) : 0;
      const x = Math.round(can.x - 3);
      const y = this.sy(can.y + 8, cam) + bob;
      if (y > VIEW_H || y + 8 < 0) continue;
      ctx.drawImage(this.sprites.can, x, y);
      // Sparkle.
      const s = Math.floor(this.time * 4 + can.phase) % 6;
      if (s < 2) {
        ctx.fillStyle = PALETTE[7];
        const sx = x + (s === 0 ? -2 : 7);
        const sy = y + (s === 0 ? 1 : 4);
        ctx.fillRect(sx, sy, 1, 1);
        ctx.fillRect(sx - 1, sy + 1, 3, 1);
        ctx.fillRect(sx, sy + 2, 1, 1);
      }
    }
  }

  private drawParticles(cam: number): void {
    const ctx = this.ctx;
    for (const q of this.particles) {
      const age = 1 - q.life / q.maxLife;
      const ci = Math.min(q.colors.length - 1, Math.floor(clamp(age, 0, 0.999) * q.colors.length));
      ctx.fillStyle = PALETTE[q.colors[ci]];
      ctx.fillRect(Math.round(q.x), this.sy(q.y, cam), q.size, q.size);
    }
  }

  private drawPlayer(cam: number, alpha: number): void {
    const ctx = this.ctx;
    const p = this.player;
    const x = Math.round(p.prevX + (p.x - p.prevX) * alpha);
    const feet = this.sy(p.prevY + (p.y - p.prevY) * alpha, cam);
    const face = p.facing > 0 ? 0 : 1;
    const sprite = (p.ground ? this.sprites.stand : this.sprites.air)[face];

    ctx.save();
    ctx.translate(x, feet);
    ctx.scale(p.sx, p.sy);
    ctx.drawImage(sprite, -PLAYER.width / 2, -PLAYER.height);
    ctx.restore();

    // Jet nozzle flame.
    if (p.thrustDir !== 0) {
      const nx = x - p.thrustDir * 5;
      const flick = Math.floor(this.time * 30) % 2;
      ctx.fillStyle = PALETTE[10];
      ctx.fillRect(p.thrustDir > 0 ? nx - 1 - flick : nx, feet - 3, 2 + flick, 2);
      ctx.fillStyle = PALETTE[7];
      ctx.fillRect(p.thrustDir > 0 ? nx : nx, feet - 3, 1, 1);
    }

    // Charge bar above the head.
    if (p.charging) {
      const w = 16;
      const bx = x - w / 2;
      const by = feet - PLAYER.height - 8;
      ctx.fillStyle = PALETTE[0];
      ctx.fillRect(bx - 1, by - 1, w + 2, 5);
      ctx.fillStyle = PALETTE[5];
      ctx.fillRect(bx, by, w, 3);
      const full = p.charge >= 1;
      const color = full ? (Math.floor(this.time * 12) % 2 ? 7 : 8) : p.charge < 0.5 ? 11 : p.charge < 0.85 ? 10 : 9;
      ctx.fillStyle = PALETTE[color];
      ctx.fillRect(bx, by, Math.max(1, Math.round(w * p.charge)), 3);
    }
  }

  /** Spiky strip on the bottom edge — touching it ends the run. Flashes when close. */
  private drawDangerEdge(): void {
    const ctx = this.ctx;
    const near = this.scrolling && this.player.y - this.camY < AUTO_SCROLL.warnDistance;
    const flash = near && Math.floor(this.time * 8) % 2 === 0;
    const shift = this.scrolling ? Math.floor(this.time * 6) % 4 : 0;
    ctx.fillStyle = PALETTE[flash ? 7 : 8];
    for (let x = -4 + shift; x < this.viewW; x += 4) {
      ctx.fillRect(x, VIEW_H - 1, 4, 1);
      ctx.fillRect(x + 1, VIEW_H - 2, 2, 1);
      ctx.fillRect(x + 1, VIEW_H - 3, 1, 1);
    }
    if (near) {
      ctx.fillStyle = PALETTE[8];
      for (let x = (Math.floor(this.time * 20) % 2); x < this.viewW; x += 2) ctx.fillRect(x, VIEW_H - 5, 1, 1);
    }
  }

  private drawHud(): void {
    const ctx = this.ctx;
    const p = this.player;
    const meters = Math.max(0, Math.floor(p.y / PX_PER_METER));
    drawText(ctx, `${meters}M`, 3, 3, 7, 2);
    drawText(ctx, `BEST ${this.best}M`, 3, 17, 10);

    // Fuel bar.
    const frac = p.fuel / JETPACK.fuelCapacity;
    const low = frac < JETPACK.lowFuelFraction;
    const flash = low && Math.floor(this.time * 6) % 2 === 0;
    const fx = 3;
    drawText(ctx, "FUEL", fx, 26, flash ? 8 : 7);
    const bx = fx + 18;
    const bw = 44;
    ctx.fillStyle = PALETTE[0];
    ctx.fillRect(bx - 1, 24, bw + 2, 9);
    ctx.fillStyle = PALETTE[1];
    ctx.fillRect(bx, 25, bw, 7);
    ctx.fillStyle = PALETTE[low ? (flash ? 7 : 8) : 12];
    ctx.fillRect(bx, 25, Math.round(bw * frac), 7);
    ctx.fillStyle = PALETTE[7];
    if (frac > 0.05) ctx.fillRect(bx, 25, Math.max(1, Math.round(bw * frac) - 1), 1);

    // Hints for new players.
    const touch = this.input.touchMode;
    let lines: string[] = [];
    if (this.hintStage === 0) {
      lines = p.charging
        ? ["RELEASE TO JUMP!"]
        : [touch ? "HOLD TO CHARGE A JUMP" : "HOLD SPACE TO CHARGE", "RELEASE TO JUMP"];
    } else if (this.hintStage === 1) {
      lines = touch ? ["IN THE AIR: HOLD LEFT/RIGHT", "SIDE TO USE JETPACK"] : ["IN THE AIR: < > OR A/D", "= JETPACK"];
    }
    lines.forEach((line, i) => {
      drawText(ctx, line, Math.round((this.viewW - textWidth(line)) / 2), 42 + i * 8, 7);
    });

    if (this.time < this.bannerUntil && Math.floor(this.time * 8) % 4 !== 0) {
      const w = textWidth(this.bannerText);
      drawText(ctx, this.bannerText, Math.round((this.viewW - w) / 2), 62, 10);
    }
  }
}
