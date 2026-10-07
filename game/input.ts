// ---------------------------------------------------------------------------
// Keyboard, mouse and touch. A pointer that goes down while the player stands
// on a platform charges a jump; one that goes down while airborne steers the
// jetpack toward the half of the screen it is on.
// ---------------------------------------------------------------------------

export type PointerRole = "jump" | "steer" | "none";

export interface InputHooks {
  /** Any user gesture (used to unlock audio). */
  onGesture(): void;
  onKeyDown(code: string): void;
  /** Decide what a new pointer press does (may also trigger UI actions). */
  classifyPointer(): PointerRole;
}

const PREVENT = new Set(["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export class Input {
  private keys = new Set<string>();
  private jumpPointers = new Set<number>();
  private steerPointers = new Map<number, -1 | 1>();
  private buttons = { left: false, right: false };
  /** True when the most recent press came from a touch screen. */
  touchMode = false;

  constructor(
    private el: HTMLElement,
    private hooks: InputHooks,
  ) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.reset);
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("lostpointercapture", this.onPointerUp);
    el.addEventListener("contextmenu", this.onContextMenu);
  }

  get jumpHeld(): boolean {
    return this.keys.has("Space") || this.jumpPointers.size > 0;
  }

  get left(): boolean {
    return this.keys.has("ArrowLeft") || this.keys.has("KeyA") || this.buttons.left || this.hasSteer(-1);
  }

  get right(): boolean {
    return this.keys.has("ArrowRight") || this.keys.has("KeyD") || this.buttons.right || this.hasSteer(1);
  }

  /** For the on-screen touch buttons. */
  setButton(dir: "left" | "right", pressed: boolean): void {
    this.buttons[dir] = pressed;
    if (pressed) this.touchMode = true;
    this.hooks.onGesture();
  }

  reset = (): void => {
    this.keys.clear();
    this.jumpPointers.clear();
    this.steerPointers.clear();
    this.buttons.left = this.buttons.right = false;
  };

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.reset);
    const el = this.el;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointercancel", this.onPointerUp);
    el.removeEventListener("lostpointercapture", this.onPointerUp);
    el.removeEventListener("contextmenu", this.onContextMenu);
  }

  private hasSteer(side: -1 | 1): boolean {
    for (const s of this.steerPointers.values()) if (s === side) return true;
    return false;
  }

  private sideOf(e: PointerEvent): -1 | 1 {
    const r = this.el.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? -1 : 1;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (PREVENT.has(e.code)) e.preventDefault();
    this.hooks.onGesture();
    this.touchMode = false;
    if (e.repeat) return;
    this.keys.add(e.code);
    this.hooks.onKeyDown(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (PREVENT.has(e.code)) e.preventDefault();
    this.keys.delete(e.code);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Let real buttons (mute, pause, touch arrows) handle their own presses.
    if ((e.target as HTMLElement | null)?.closest?.("button")) return;
    e.preventDefault();
    this.touchMode = e.pointerType !== "mouse";
    this.hooks.onGesture();
    const role = this.hooks.classifyPointer();
    if (role === "none") return;
    if (role === "jump") this.jumpPointers.add(e.pointerId);
    else this.steerPointers.set(e.pointerId, this.sideOf(e));
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer may already be gone */
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.steerPointers.has(e.pointerId)) this.steerPointers.set(e.pointerId, this.sideOf(e));
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.type === "pointerup") this.hooks.onGesture();
    this.jumpPointers.delete(e.pointerId);
    this.steerPointers.delete(e.pointerId);
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };
}
