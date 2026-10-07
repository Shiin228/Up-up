import { JETPACK, PHYSICS, PLAYER, VIEW_W } from "./config";
import type { Platform, World } from "./world";

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Controls {
  jumpHeld: boolean;
  left: boolean;
  right: boolean;
}

export type PlayerEvent =
  | { type: "chargeStart" }
  | { type: "jump"; charge: number }
  | { type: "land"; speed: number; platform: Platform }
  | { type: "fallOff" };

/**
 * One airborne physics step. Shared by the player and by the level
 * generator's reach simulation, so "reachable" means exactly what the
 * player can actually do.
 */
export function stepAirborne(b: Body, thrustDir: number, windAccel: number, dt: number): void {
  const ax = thrustDir * JETPACK.thrust + windAccel - b.vx * PHYSICS.airDrag;
  const maxVx = PHYSICS.maxHorizontalSpeed;
  b.vx = Math.max(-maxVx, Math.min(maxVx, b.vx + ax * dt));
  b.vy = Math.max(b.vy - PHYSICS.gravity * dt, -PHYSICS.maxFallSpeed);
  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

export function jumpVelocity(charge: number): number {
  const c = Math.max(0, Math.min(1, charge));
  return PHYSICS.jumpMinVelocity + (PHYSICS.jumpMaxVelocity - PHYSICS.jumpMinVelocity) * c;
}

const HALF_W = PLAYER.width / 2;

export class Player implements Body {
  /** Center x. */
  x = VIEW_W / 2;
  /** Feet y (world y grows upward). */
  y = 0;
  vx = 0;
  vy = 0;
  prevX = this.x;
  prevY = this.y;
  ground: Platform | null = null;
  charging = false;
  charge = 0;
  fuel = JETPACK.fuelCapacity;
  facing: 1 | -1 = 1;
  /** -1, 0 or 1: the direction the jetpack fired this step. */
  thrustDir = 0;
  /** Squash & stretch scale factors. */
  sx = 1;
  sy = 1;
  /** Highest feet position reached this run. */
  maxY = 0;
  events: PlayerEvent[] = [];

  reset(x: number, ground: Platform): void {
    this.x = this.prevX = x;
    this.y = this.prevY = ground.y;
    this.vx = this.vy = 0;
    this.ground = ground;
    this.charging = false;
    this.charge = 0;
    this.fuel = JETPACK.fuelCapacity;
    this.facing = 1;
    this.thrustDir = 0;
    this.sx = this.sy = 1;
    this.maxY = ground.y;
    this.events.length = 0;
  }

  update(dt: number, ctl: Controls, world: World): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.thrustDir = 0;

    if (this.ground && this.ground.state === "broken") {
      this.ground = null;
      this.charging = false;
      this.charge = 0;
      this.events.push({ type: "fallOff" });
    }

    if (this.ground) {
      this.updateGrounded(dt, ctl, this.ground);
    } else {
      this.updateAirborne(dt, ctl, world);
    }

    // Squash & stretch eases back to 1 (charging overrides it directly).
    if (!this.charging) {
      const k = Math.min(1, 12 * dt);
      this.sx += (1 - this.sx) * k;
      this.sy += (1 - this.sy) * k;
    }
    if (this.y > this.maxY) this.maxY = this.y;
  }

  private updateGrounded(dt: number, ctl: Controls, p: Platform): void {
    this.vx = 0;
    this.vy = 0;
    this.y = p.y;

    if (ctl.jumpHeld) {
      if (!this.charging) {
        this.charging = true;
        this.charge = 0;
        this.events.push({ type: "chargeStart" });
      }
      this.charge = Math.min(1, this.charge + dt / PHYSICS.chargeTime);
      this.sx = 1 + 0.25 * this.charge;
      this.sy = 1 - 0.3 * this.charge;
    } else if (this.charging) {
      this.vy = jumpVelocity(this.charge);
      this.events.push({ type: "jump", charge: this.charge });
      this.ground = null;
      this.charging = false;
      this.charge = 0;
      this.sx = 0.75;
      this.sy = 1.3;
    }
  }

  private updateAirborne(dt: number, ctl: Controls, world: World): void {
    this.charging = false;
    const dir = (ctl.right ? 1 : 0) - (ctl.left ? 1 : 0);
    if (dir !== 0 && this.fuel > 0) {
      this.thrustDir = dir;
      this.facing = dir > 0 ? 1 : -1;
      this.fuel = Math.max(0, this.fuel - JETPACK.drainPerSecond * dt);
    }

    const wind = world.windAt(this.y + PLAYER.height / 2);
    stepAirborne(this, this.thrustDir, wind, dt);

    // Side walls.
    if (this.x < HALF_W) {
      this.x = HALF_W;
      if (this.vx < 0) this.vx = 0;
    } else if (this.x > world.width - HALF_W) {
      this.x = world.width - HALF_W;
      if (this.vx > 0) this.vx = 0;
    }

    // One-way platforms: land only while falling through the top surface.
    if (this.vy <= 0) {
      let landed: Platform | null = null;
      for (const p of world.platforms()) {
        if (p.state === "broken") continue;
        if (this.prevY >= p.y && this.y <= p.y && this.x + HALF_W > p.x && this.x - HALF_W < p.x + p.w) {
          if (!landed || p.y > landed.y) landed = p;
        }
      }
      if (landed) {
        const speed = -this.vy;
        this.y = landed.y;
        this.vy = 0;
        this.vx = 0;
        this.ground = landed;
        const squash = Math.min(1, speed / 400);
        this.sx = 1 + 0.4 * squash;
        this.sy = 1 - 0.35 * squash;
        this.events.push({ type: "land", speed, platform: landed });
      }
    }
  }
}
