"use client";

import dynamic from "next/dynamic";

// The game touches window, canvas, Web Audio and localStorage, so it is only
// ever rendered in the browser.
const Game = dynamic(() => import("./Game"), {
  ssr: false,
  loading: () => <p className="loading">LOADING…</p>,
});

export default function GameClient() {
  return <Game />;
}
