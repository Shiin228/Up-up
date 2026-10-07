# UP UP

An endless, 8-bit vertical climbing game. You can only jump **straight up**, and you
steer in the air with a tiny jetpack that runs on very little fuel. The screen keeps
rising, and touching its bottom edge ends the run.

The game fills the whole window. The view is always 240 game pixels tall (`VIEW_H`
in `game/config.ts`; lower = more zoomed in), and its
width follows your screen's shape, from 128 px on a phone up to 720 px on an
ultra-wide monitor. Wider screens get more parallel routes of platforms.

Built with Next.js (App Router) and TypeScript. It has no game engine, no physics
library, and no image or audio files. Every sprite is drawn in code, and every sound
is generated with the Web Audio API, including a looping 8-bit space soundtrack
(`game/music.ts`) that gains layers as you climb from sunset to night to space.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000.

To deploy, push the repo to GitHub and import it in Vercel. No configuration is needed.
`npm run build && npm start` runs a production build locally.

## Controls

| Action                     | Keyboard               | Mouse / touch                                                        |
| -------------------------- | ---------------------- | -------------------------------------------------------------------- |
| Charge jump                | Hold **Space**         | Press and hold while standing                                        |
| Jump                       | Release **Space**      | Release                                                              |
| Jetpack left/right (air)   | **← →** or **A D**     | Hold the left/right half of the screen, or the on-screen ◀ ▶ buttons |
| Pause / resume             | **P** or **Esc**       | ❚❚ button (tap to resume)                                            |
| Restart after game over    | **R** or **Enter**     | Tap                                                                  |
| Mute all sound             | **M**                  | Speaker button                                                       |
| Music on/off               | **N**                  | Note button                                                          |
| Fullscreen                 | **F**                  | Corner button                                                        |

You can't use the jetpack while standing. **Fuel never refills on its own.** The only
source is red fuel canisters. A can sitting on a platform is collected as soon as you
land anywhere on that platform. Cans are rare, but the generator places one wherever a
careful climber would otherwise run dry.

The screen starts rising after your first jump and rises faster the higher you get.
The spiky strip at the bottom flashes and beeps when you're close to it.

**Seeds:** every run shows its seed on the game-over screen. Open `/?seed=12345` to
replay that exact level (restarts reuse the same seed).

## Tweaking difficulty

**All tuning numbers live in [`game/config.ts`](game/config.ts):**

- `PHYSICS`: gravity, min/max jump speed, charge time, air drag, max speed
- `JETPACK`: thrust, fuel capacity, drain rate, fuel per canister (`pickupRefill`)
- `AUTO_SCROLL`: how fast the screen rises (start and max speed) and when the
  bottom-edge warning kicks in
- `DIFFICULTY`: how fast difficulty rises with height (`scaleMeters`) and its hard `cap`
- `GENERATION`:
  - Platforms: widths, the extra width of crumbling platforms
    (`crumbleExtraWidth`), and vertical gaps.
  - Sideways placement: spread and how much of the reachable distance a platform
    uses (`lateralDemandMin/Max`).
  - Side platforms (`extraPlatformChance`) and the number of parallel routes
    (`routeSpacing`).
  - Crumble chance.
  - Fuel economy: `fuelLegChance` and `fuelLegBudget` (how often and how much a
    jump may need the jetpack), `refuelThreshold`, and `bonusPickupChance`.
  - The fairness margins.
- `WIND`: when wind starts, how often it appears, and how strong it gets
- `PLATFORM.crumbleTime` (how long a crumbling platform holds), `CAMERA`, `FEEL`
  (screen shake, particles), `THEMES`

Most values are `[easy, hard]` pairs. The game interpolates between them using a
difficulty value from 0 to 1 that rises with height (about 0.04 at 10 m, 0.37 at
100 m and 0.74 at 300 m, capped at 0.92).

### How the levels stay fair

The level is generated a few rows at a time as you climb, using a seeded RNG. It is
built as one or more **guaranteed routes**. Before each platform on a route is placed,
the generator **simulates the real player physics** (`stepAirborne` in
`game/player.ts`). That check, which includes worst-case wind and a safety margin,
works out three things:

- a landing spot of at least 10 px that can be hit from the previous landing spot;
- the least fuel that jump needs;
- the fuel a careful climber is guaranteed to have left.

When that guaranteed fuel would drop below 30%, a refuel can is placed on the next
route platform. Side platforms are kept only if you can rejoin the route from them.

A few more rules:

- You never get more than two crumbling platforms in a row. A second one always
  carries a fuel canister, and every crumbling platform keeps a guaranteed way off it.
- Wind bands are spaced farther apart than the highest possible jump, so a single
  jump never crosses two of them.

If you change the physics constants, reachability adapts automatically. The rising
screen is the one thing it doesn't model, so if you raise `AUTO_SCROLL.speed` a lot,
play-test it.

## Project layout

```
app/layout.tsx, app/page.tsx   Next.js shell, Press Start 2P font, global styles
components/GameClient.tsx      Loads the game client-side only (ssr: false)
components/Game.tsx            Mounts the canvas and holds the overlays and buttons
game/config.ts                 All tuning numbers
game/engine.ts                 Fixed-timestep loop, game rules, rendering, HUD
game/player.ts                 Player state and the shared physics step
game/world.ts                  Chunks, seeded RNG, wind, reachability checks
game/sprites.ts                16-color palette, pixel art, 3x5 HUD font
game/audio.ts                  Web Audio sound effects
game/music.ts                  Background music sequencer (8-bit space loop)
game/input.ts                  Keyboard, mouse and touch
```
