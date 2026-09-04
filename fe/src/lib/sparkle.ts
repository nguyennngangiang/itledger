import anime from "animejs";

const COLORS = ["#a5b4fc", "#93c5fd", "#6ee7b7", "#fcd34d", "#f9a8d4", "#c4b5fd"];
const STAR =
  "M12 0l2.9 8.26L24 9.2l-6.8 5.52L19.6 24 12 18.9 4.4 24l2.4-9.28L0 9.2l9.1-.94z";

/** Fire a burst of glittery stars outward from a screen coordinate. */
export function burstSparkles(x: number, y: number, count = 16) {
  const layer = document.createElement("div");
  layer.className = "sparkle-burst-layer";
  document.body.appendChild(layer);

  const nodes: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const s = document.createElement("span");
    s.className = "sparkle-star";
    const size = 6 + Math.random() * 12;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.width = `${size}px`;
    s.style.height = `${size}px`;
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    s.style.color = color;
    s.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="${STAR}" fill="currentColor"/></svg>`;
    layer.appendChild(s);
    nodes.push(s);
  }

  anime({
    targets: nodes,
    translateX: () => anime.random(-120, 120),
    translateY: () => anime.random(-120, 120),
    scale: [{ value: () => 0.6 + Math.random(), duration: 0 }, { value: 0, duration: 750 }],
    rotate: () => anime.random(-360, 360),
    opacity: [{ value: 1, duration: 0 }, { value: 0, duration: 800, easing: "easeInQuad" }],
    duration: 850,
    easing: "easeOutExpo",
    complete: () => layer.remove(),
  });
}

/**
 * Globally sparkle on clicks of "hero" controls (nav, primary + quick-add
 * buttons). Returns a cleanup fn. Kept selective so table clicks stay calm.
 */
export function installSparkleClicks(): () => void {
  const SELECTOR =
    ".quick-add-btn, .ant-btn-primary, .topnav-item, .status-chip, .stat-card";
  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement | null)?.closest(SELECTOR);
    if (el) burstSparkles(e.clientX, e.clientY);
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}

/** Staggered entrance for a set of elements (fade + rise + pop). */
export function animateEntrance(targets: string | HTMLElement | HTMLElement[], delayStep = 70) {
  anime({
    targets,
    opacity: [0, 1],
    translateY: [22, 0],
    scale: [0.94, 1],
    delay: anime.stagger(delayStep),
    duration: 720,
    easing: "easeOutElastic(1, 0.7)",
  });
}

/**
 * Springy "press" feedback on interactive controls. A quick squash-and-release
 * on pointerdown makes every button/tab/chip feel physical. Returns a cleanup
 * fn. Kept off table cells and inputs so data interactions stay calm.
 */
export function installButtonPress(): () => void {
  const SELECTOR =
    ".ant-btn, .topnav-item, .status-chip, .quick-add-btn, .bulk-bar-actions .ant-btn";
  const onDown = (e: PointerEvent) => {
    const el = (e.target as HTMLElement | null)?.closest(SELECTOR) as HTMLElement | null;
    if (!el) return;
    anime.remove(el);
    anime({
      targets: el,
      scale: [{ value: 0.9, duration: 90 }, { value: 1, duration: 340 }],
      easing: "easeOutElastic(1, 0.5)",
    });
  };
  document.addEventListener("pointerdown", onDown, true);
  return () => document.removeEventListener("pointerdown", onDown, true);
}

/** anime.js writes inline styles, so the CSS `transition: none` under
 * prefers-reduced-motion (App.css) cannot reach the pill — it has to be asked here. */
const reduceMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Is the pill hidden, or on its way there? An unset opacity means fully shown. */
function isFading(el: HTMLElement) {
  const o = el.style.opacity;
  return o !== "" && parseFloat(o) < 1;
}

/**
 * Slide the active nav "pill" indicator to the current tab. Animates the
 * highlight element's position/width to match the active button, with a smooth
 * glide plus a tiny squash-and-stretch so the switch feels playful.
 *
 * Coming back from a page with no tab (Dashboard, Notifications) the pill is
 * hidden and parked wherever it last was, so it is moved into place *before*
 * fading in — otherwise it would streak across the nav from a stale position.
 */
export function slideNavIndicator(indicator: HTMLElement, active: HTMLElement) {
  // "" = never faded, i.e. fully visible. Anything below 1 counts as hidden so a
  // fast bell → tab click mid-fade still snaps rather than streaks.
  const hidden = isFading(indicator);
  const still = reduceMotion();

  if (hidden || still) {
    anime.remove(indicator);
    indicator.style.left = `${active.offsetLeft}px`;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.opacity = "1";
    return;
  }

  anime({
    targets: indicator,
    left: active.offsetLeft,
    width: active.offsetWidth,
    opacity: 1,
    duration: 620,
    easing: "cubicBezier(0.22, 1, 0.36, 1)", // smooth easeOutQuint-like glide
  });
  anime({
    targets: indicator,
    scaleY: [{ value: 0.72, duration: 150 }, { value: 1, duration: 470 }],
    scaleX: [{ value: 1.06, duration: 150 }, { value: 1, duration: 470 }],
    easing: "easeOutBack",
  });
}

/**
 * Retract the pill when no tab is active.
 *
 * Dashboard (the brand) and Notifications (the bell) are pages without a nav
 * tab. Leaving the pill parked under the tab you came from left a purple slab
 * behind — and that tab, having lost `.active`, had gone back to dark text, so
 * it read as black-on-purple.
 */
export function hideNavIndicator(indicator: HTMLElement) {
  if (indicator.style.opacity === "0") return;
  if (reduceMotion() || indicator.style.width === "" || indicator.style.width === "0px") {
    // Nothing was ever shown (first paint lands on Dashboard) — no fade to run.
    anime.remove(indicator);
    indicator.style.opacity = "0";
    return;
  }
  anime({
    targets: indicator,
    opacity: 0,
    duration: 180,
    easing: "easeOutQuad",
  });
}

/**
 * Bigger, smoother page-content reveal on tab switch: content sweeps up from
 * further down with a soft scale, staggered so panels cascade in. Smoother
 * (no bounce) than the first-paint entrance, with more travel for impact.
 */
export function animateSwitch(targets: string | HTMLElement | HTMLElement[], delayStep = 55) {
  anime({
    targets,
    opacity: [0, 1],
    translateY: [46, 0],
    scale: [0.92, 1],
    delay: anime.stagger(delayStep, { start: 10 }),
    duration: 520,
    easing: "easeOutExpo",
  });
}
