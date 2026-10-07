"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { VIEW_H, VIEW_W } from "@/game/config";
import { Engine, type UiState } from "@/game/engine";

export default function Game() {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [ui, setUi] = useState<UiState | null>(null);
  const [viewport, setViewport] = useState({ w: VIEW_W * 2, h: VIEW_H * 2 });
  const [coarse, setCoarse] = useState(false);

  // Mount the engine; it owns the loop and all input listeners.
  useEffect(() => {
    const engine = new Engine(canvasRef.current!, frameRef.current!, { onUi: setUi });
    engineRef.current = engine;
    engine.start();
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Track the window size; the engine picks a canvas width that fills it.
  useEffect(() => {
    const fit = () => {
      setViewport({
        w: window.visualViewport?.width ?? window.innerWidth,
        h: window.visualViewport?.height ?? window.innerHeight,
      });
    };
    fit();
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);

    const mq = window.matchMedia("(pointer: coarse)");
    const onMq = () => setCoarse(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    return () => {
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      mq.removeEventListener("change", onMq);
    };
  }, []);

  // Scale the canvas (320 px tall, width from the engine) to fill the window.
  const viewW = ui?.viewW ?? VIEW_W;
  const unit = Math.max(1, Math.min(viewport.w / viewW, viewport.h / VIEW_H));
  const frameStyle = {
    width: Math.floor(viewW * unit),
    height: Math.floor(VIEW_H * unit),
    "--u": `${unit}px`,
  } as CSSProperties;
  const screen = ui?.screen ?? "title";

  const press = (dir: "left" | "right", pressed: boolean) => (e: PointerEvent<HTMLButtonElement>) => {
    if (pressed) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    engineRef.current?.input.setButton(dir, pressed);
  };

  return (
    <div ref={frameRef} className="frame" style={frameStyle}>
      <canvas ref={canvasRef} className="screen" width={VIEW_W} height={VIEW_H} aria-label="Up Up game" />

      {screen === "title" && (
        <div className="overlay">
          <h1 className="logo">
            UP
            <br />
            UP
          </h1>
          <p className="best">Best: {ui?.best ?? 0}m</p>
          <p className="blink prompt">
            Hold {coarse ? "the screen" : "SPACE or CLICK"}
            <br />
            to start
          </p>
          <div className="howto">
            <p>
              <span className="key">HOLD</span> charge jump
            </p>
            <p>
              <span className="key">RELEASE</span> jump up
            </p>
            {coarse ? (
              <p>
                <span className="key">TOUCH L/R</span> jetpack (in air)
              </p>
            ) : (
              <p>
                <span className="key">← → / A D</span> jetpack (in air)
              </p>
            )}
            <p className="dim">Fuel never refills: grab cans!</p>
            <p className="dim">The screen rises. Don&apos;t touch the bottom!</p>
          </div>
        </div>
      )}

      {screen === "paused" && (
        <div className="overlay dimmed">
          <h2 className="big">PAUSED</h2>
          <p className="prompt">{coarse ? "Tap to resume" : "Press P or ESC to resume"}</p>
        </div>
      )}

      {screen === "over" && ui && (
        <div className="overlay dimmed">
          <h2 className="big red">GAME OVER</h2>
          <p className="stat">
            HEIGHT <span>{ui.height}m</span>
          </p>
          <p className="stat">
            BEST <span>{ui.best}m</span>
          </p>
          {ui.newBest && <p className="blink newbest">NEW BEST!</p>}
          <p className="prompt blink">{coarse ? "Tap to try again" : "Press R to try again"}</p>
          <p className="seed">SEED {ui.seed}</p>
        </div>
      )}

      <div className="corner">
        {(screen === "playing" || screen === "paused") && (
          <button
            type="button"
            className="icon-btn"
            aria-label={screen === "paused" ? "Resume" : "Pause"}
            onClick={(e) => {
              engineRef.current?.togglePause();
              e.currentTarget.blur();
            }}
          >
            {screen === "paused" ? <PlayIcon /> : <PauseIcon />}
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label={ui?.muted ? "Unmute" : "Mute"}
          aria-pressed={ui?.muted ?? false}
          onClick={(e) => {
            engineRef.current?.toggleMute();
            e.currentTarget.blur();
          }}
        >
          <SpeakerIcon muted={ui?.muted ?? false} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={ui?.musicOn === false ? "Music on" : "Music off"}
          aria-pressed={ui?.musicOn ?? true}
          onClick={(e) => {
            engineRef.current?.toggleMusic();
            e.currentTarget.blur();
          }}
        >
          <MusicIcon on={ui?.musicOn ?? true} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Toggle fullscreen"
          onClick={(e) => {
            engineRef.current?.toggleFullscreen();
            e.currentTarget.blur();
          }}
        >
          <FullscreenIcon />
        </button>
      </div>

      {coarse && screen === "playing" && (
        <>
          <button
            type="button"
            className="touch-btn left"
            aria-label="Jetpack left"
            onPointerDown={press("left", true)}
            onPointerUp={press("left", false)}
            onPointerCancel={press("left", false)}
            onLostPointerCapture={press("left", false)}
          >
            <ArrowIcon dir={-1} />
          </button>
          <button
            type="button"
            className="touch-btn right"
            aria-label="Jetpack right"
            onPointerDown={press("right", true)}
            onPointerUp={press("right", false)}
            onPointerCancel={press("right", false)}
            onLostPointerCapture={press("right", false)}
          >
            <ArrowIcon dir={1} />
          </button>
        </>
      )}
    </div>
  );
}

// --- Tiny pixel icons (crisp rects, no image files) ------------------------

function PixelSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
      {children}
    </svg>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <PixelSvg>
      <rect x="0" y="3" width="2" height="2" fill="currentColor" />
      <rect x="2" y="2" width="1" height="4" fill="currentColor" />
      <rect x="3" y="1" width="1" height="6" fill="currentColor" />
      {muted ? (
        <>
          <rect x="5" y="2" width="1" height="1" fill="#ff004d" />
          <rect x="7" y="2" width="1" height="1" fill="#ff004d" />
          <rect x="6" y="3" width="1" height="2" fill="#ff004d" />
          <rect x="5" y="5" width="1" height="1" fill="#ff004d" />
          <rect x="7" y="5" width="1" height="1" fill="#ff004d" />
        </>
      ) : (
        <>
          <rect x="5" y="3" width="1" height="2" fill="currentColor" />
          <rect x="6" y="1" width="1" height="1" fill="currentColor" />
          <rect x="7" y="2" width="1" height="4" fill="currentColor" />
          <rect x="6" y="6" width="1" height="1" fill="currentColor" />
        </>
      )}
    </PixelSvg>
  );
}

function MusicIcon({ on }: { on: boolean }) {
  return (
    <PixelSvg>
      <rect x="3" y="0" width="1" height="6" fill="currentColor" />
      <rect x="4" y="0" width="3" height="1" fill="currentColor" />
      <rect x="6" y="1" width="1" height="1" fill="currentColor" />
      <rect x="1" y="5" width="3" height="2" fill="currentColor" />
      {!on && (
        <>
          <rect x="0" y="0" width="1" height="1" fill="#ff004d" />
          <rect x="1" y="1" width="1" height="1" fill="#ff004d" />
          <rect x="5" y="5" width="1" height="1" fill="#ff004d" />
          <rect x="6" y="6" width="1" height="1" fill="#ff004d" />
          <rect x="7" y="7" width="1" height="1" fill="#ff004d" />
        </>
      )}
    </PixelSvg>
  );
}

function FullscreenIcon() {
  return (
    <PixelSvg>
      <rect x="0" y="0" width="3" height="1" fill="currentColor" />
      <rect x="0" y="0" width="1" height="3" fill="currentColor" />
      <rect x="5" y="0" width="3" height="1" fill="currentColor" />
      <rect x="7" y="0" width="1" height="3" fill="currentColor" />
      <rect x="0" y="7" width="3" height="1" fill="currentColor" />
      <rect x="0" y="5" width="1" height="3" fill="currentColor" />
      <rect x="5" y="7" width="3" height="1" fill="currentColor" />
      <rect x="7" y="5" width="1" height="3" fill="currentColor" />
    </PixelSvg>
  );
}

function PauseIcon() {
  return (
    <PixelSvg>
      <rect x="1" y="1" width="2" height="6" fill="currentColor" />
      <rect x="5" y="1" width="2" height="6" fill="currentColor" />
    </PixelSvg>
  );
}

function PlayIcon() {
  return (
    <PixelSvg>
      <rect x="2" y="1" width="1" height="6" fill="currentColor" />
      <rect x="3" y="2" width="1" height="4" fill="currentColor" />
      <rect x="4" y="3" width="1" height="2" fill="currentColor" />
    </PixelSvg>
  );
}

function ArrowIcon({ dir }: { dir: -1 | 1 }) {
  return (
    <PixelSvg>
      <g transform={dir < 0 ? "translate(8 0) scale(-1 1)" : undefined}>
        <rect x="2" y="1" width="1" height="6" fill="currentColor" />
        <rect x="3" y="2" width="1" height="4" fill="currentColor" />
        <rect x="4" y="3" width="2" height="2" fill="currentColor" />
      </g>
    </PixelSvg>
  );
}
