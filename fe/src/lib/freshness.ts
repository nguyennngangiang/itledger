// Make sure the phone runs the build the server has.
//
// Safari can keep a page — and the JS it loaded — for a long time without
// asking the server again (tab restored after being killed, back/forward
// cache, a home-screen web app). A fix deployed on the server then never
// reaches that phone. So the app asks /version.json (never cached) when it
// starts, whenever it comes back to the foreground, and before the Scan screen
// opens; a different build id means reload. Guarded so a server that keeps
// answering a different id cannot cause a reload loop.
declare const __BUILD_ID__: string;

const KEY = "itledger.reloadedFor";

export async function ensureFresh(): Promise<void> {
  if (typeof __BUILD_ID__ === "undefined" || import.meta.env.DEV) return;
  try {
    const url = new URL("version.json", new URL(import.meta.env.BASE_URL, location.href));
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return;
    const { build } = (await r.json()) as { build?: string };
    if (!build || build === __BUILD_ID__) return;
    // Reload once per newer build id, never twice for the same one.
    if (sessionStorage.getItem(KEY) === build) return;
    sessionStorage.setItem(KEY, build);
    location.reload();
  } catch {
    // offline / storage blocked: carry on with what we have
  }
}

export function watchFreshness() {
  ensureFresh();
  const onShow = () => {
    if (document.visibilityState === "visible") ensureFresh();
  };
  document.addEventListener("visibilitychange", onShow);
  window.addEventListener("pageshow", onShow);
}
