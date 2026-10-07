/**
 * setInterval that skips ticks while the tab is hidden, and runs once as soon
 * as the tab becomes visible again. Tabs left open in the background were
 * polling the API (and the database behind it) around the clock, which counts
 * against the Supabase egress quota.
 * @returns a cleanup function, for useEffect.
 */
export function setVisibleInterval(callback: () => void, ms: number): () => void {
  const tick = () => {
    if (document.visibilityState === "visible") callback();
  };
  const id = window.setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", tick);
  };
}
