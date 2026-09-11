// T.A.L.O.N.'s unattended trading loop — RETIRED.
//
// This used to scan the watchlist every few minutes and open/close positions
// with no confirmation. Removed as part of rebuilding T.A.L.O.N. down to
// essential, on-request tools only: he now reads the market and manages a
// trade only when directly asked in chat, and every order (open, close, or
// move a stop) requires a tap to confirm before it fires — see sendTrade,
// closePosition and moveToBreakeven in CommandScreen.js.
//
// The exports below are kept as inert stubs so App.js, SettingsScreen,
// hud/panels.js and CommandScreen's busy-indicator don't need to change —
// they just always see "not running".
export function onAutoTrade(){return()=>{};}
export function autoTraderRunning(){return false;}
export function autoTraderBusy(){return false;}
export function autoTraderLastCycleAt(){return 0;}
export async function startAutoTrader(){/* retired — no-op */}
export function stopAutoTrader(){/* retired — no-op */}
export async function refreshAutoTrader(){/* retired — no-op */}
