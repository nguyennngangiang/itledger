// Design tokens for code that paints on a <canvas> (the camera overlays),
// read from :root so the overlay and the CSS can never drift apart.
const cache = new Map<string, string>();

export function cssVar(name: string): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, v);
  }
  return v;
}
