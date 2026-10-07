// ---------------------------------------------------------------------------
// Palette + pixel art. Sprites are strings where each char is a palette index
// in hex ("0"-"f"), "." is transparent, and other letters are per-sprite
// placeholders resolved through a color map.
// ---------------------------------------------------------------------------

/** The 16-color PICO-8 palette. */
export const PALETTE = [
  "#000000", // 0 black
  "#1d2b53", // 1 dark blue
  "#7e2553", // 2 dark purple
  "#008751", // 3 dark green
  "#ab5236", // 4 brown
  "#5f574f", // 5 dark gray
  "#c2c3c7", // 6 light gray
  "#fff1e8", // 7 white
  "#ff004d", // 8 red
  "#ffa300", // 9 orange
  "#ffec27", // 10 yellow
  "#00e436", // 11 green
  "#29adff", // 12 blue
  "#83769c", // 13 lavender
  "#ff77a8", // 14 pink
  "#ffccaa", // 15 peach
] as const;

/** Palette as little-endian ABGR uint32 values for ImageData writes. */
export const PALETTE_U32 = PALETTE.map((hex) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
});

export type PixelArt = readonly string[];

// --- Player (faces right; jetpack on the back) -----------------------------

export const PLAYER_STAND: PixelArt = [
  "..6777..",
  ".67cccc.",
  ".67c7cc.",
  "5566777.",
  "5d99999.",
  "5d9999f.",
  "5d4444..",
  "5.9999..",
  "..9..9..",
  ".11..11.",
];

export const PLAYER_AIR: PixelArt = [
  "..6777..",
  ".67cccc.",
  ".67c7cc.",
  "5566777.",
  "5d99999f",
  "5d99999.",
  "5d4444..",
  "5.9999..",
  ".9....9.",
  "11....11",
];

// --- Pickups / effects ------------------------------------------------------

export const FUEL_CAN: PixelArt = [
  "..66..",
  ".5555.",
  ".8888.",
  ".8a88.",
  ".8aa8.",
  ".8a88.",
  ".8888.",
  ".2222.",
];

export const CHEVRON: PixelArt = ["x..", ".x.", "..x", ".x.", "x.."];

export const CLOUD_A: PixelArt = [
  "....xxxx........",
  "..xxxxxxxx.xx...",
  ".xxxxxxxxxxxxxx.",
  "xxxxxxxxxxxxxxxx",
  "yyxxxxxxxxxxxyyy",
  ".yyyyyyyyyyyyy..",
];

export const CLOUD_B: PixelArt = [
  "...xxx......",
  ".xxxxxxx.x..",
  "xxxxxxxxxxx.",
  "yxxxxxxxxxxy",
  ".yyyyyyyyyy.",
];

// --- Platform tiles (8x6), one solid style per sky theme -------------------

export const TILE_SOLID: readonly PixelArt[] = [
  // 0: sunset — grass & dirt
  ["bbbbbbbb", "3bb3bbb3", "43444434", "44544444", "44444454", "54444444"],
  // 1: night — stone
  ["66666666", "6dd66ddd", "dddd5ddd", "d5ddddd5", "ddd5dddd", "55555555"],
  // 2: space — riveted metal
  ["77777777", "6c6666c6", "66666666", "65666656", "66666666", "55555555"],
];

/** Cracked sandstone that crumbles. */
export const TILE_CRUMBLE: PixelArt = ["ffffffff", "f9ff0f9f", "990f9909", "94099490", "40944904", "44404444"];

/** Debris colors per platform kind/theme (used for particles). */
export const DEBRIS_COLORS = {
  crumble: [15, 9, 4],
  solid: [[11, 3, 4], [6, 13, 5], [7, 6, 5]],
} as const;

// --- Sprite baking -----------------------------------------------------------

export function bakeSprite(art: PixelArt, colorMap: Record<string, number> = {}): HTMLCanvasElement {
  const h = art.length;
  const w = art[0].length;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = art[y][x];
      if (ch === ".") continue;
      const idx = ch in colorMap ? colorMap[ch] : parseInt(ch, 16);
      if (Number.isNaN(idx)) continue;
      ctx.fillStyle = PALETTE[idx];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

/** Horizontally mirrored copy of a baked sprite. */
export function mirrorSprite(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.translate(src.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

// --- 3x5 bitmap font for the HUD (crisp at any scale) -----------------------

const GLYPHS: Record<string, string> = {
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001011001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001001010010",
  "8": "111101111101111",
  "9": "111101111001111",
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "110101101101101",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101110011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101111111101",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  "!": "010010010000010",
  ".": "000000000000010",
  ":": "000010000010000",
  "-": "000000111000000",
  "/": "001001010100100",
  "=": "000111000111000",
  "<": "001010100010001",
  ">": "100010001010100",
  "&": "010101010101011",
  " ": "000000000000000",
};

export function textWidth(text: string, scale = 1): number {
  return text.length ? (text.length * 4 - 1) * scale : 0;
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: number,
  scale = 1,
  shadow: number | null = 0,
): void {
  const up = text.toUpperCase();
  const pass = (ox: number, oy: number, col: number) => {
    ctx.fillStyle = PALETTE[col];
    let cx = x + ox;
    for (const ch of up) {
      const g = GLYPHS[ch] ?? GLYPHS[" "];
      for (let i = 0; i < 15; i++) {
        if (g[i] === "1") ctx.fillRect(cx + (i % 3) * scale, y + oy + Math.floor(i / 3) * scale, scale, scale);
      }
      cx += 4 * scale;
    }
  };
  if (shadow !== null) pass(scale, scale, shadow);
  pass(0, 0, color);
}
