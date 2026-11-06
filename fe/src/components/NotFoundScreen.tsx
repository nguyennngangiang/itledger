// The 404 page. The app has no router — every path is served index.html by the
// web server (try_files) — so main.tsx renders this instead of <App/> for any
// path that isn't the root.
import { useEffect, useRef } from "react";
import anime from "animejs";
import gangImg from "../assets/404-gang.webp";
import { burstSparkles } from "../lib/sparkle";
import { useT } from "../i18n/useT";
import { T } from "../i18n/I18nProvider";

const DROPS = ["🔥", "💯", "😤", "⚡", "💥", "🤙", "✨", "👑"];
const STICKERS = ["NO PAGE", "GIANG GANG", "404 BARS", "SKRRT"];

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function NotFoundScreen() {
  const { t } = useT();
  const root = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion()) return;
    const q = (sel: string) => el.querySelectorAll<HTMLElement>(sel);

    const intro = anime
      .timeline({ easing: "easeOutElastic(1, .55)" })
      .add({ targets: q(".nf-digits span"), translateY: [-260, 0], rotate: () => anime.random(-40, 40), opacity: [0, 1], delay: anime.stagger(120), duration: 1100 })
      .add({ targets: q(".nf-hero"), translateY: [420, 0], scale: [0.6, 1], duration: 1400 }, "-=900")
      .add({ targets: q(".nf-shades"), translateY: [-600, 0], rotate: [-25, 0], opacity: [0, 1], easing: "easeOutBounce", duration: 1100 }, "+=150")
      .add({ targets: q(".nf-sticker"), scale: [0, 1], rotate: (_: Element, i: number) => [0, i % 2 ? 9 : -11], opacity: [0, 1], delay: anime.stagger(140), duration: 800 }, "-=500")
      .add({ targets: q(".nf-copy, .nf-home"), translateY: [30, 0], opacity: [0, 1], easing: "easeOutExpo", delay: anime.stagger(100), duration: 700 }, "-=600");

    // Head-nod on the beat once she has landed.
    const bob = anime({ targets: q(".nf-hero img"), translateY: [0, -10], rotate: [-1.5, 1.5], direction: "alternate", loop: true, easing: "easeInOutSine", duration: 430, delay: 2600 });
    const wobble = anime({ targets: q(".nf-sticker"), scale: [1, 1.12], direction: "alternate", loop: true, easing: "easeInOutQuad", duration: 430, delay: anime.stagger(215, { start: 2600 }) });

    // Something falls from the sky every so often; each drop cleans up after itself.
    const rain = window.setInterval(() => {
      const d = document.createElement("span");
      d.className = "nf-drop";
      d.textContent = DROPS[(Math.random() * DROPS.length) | 0];
      d.style.left = `${Math.random() * 100}%`;
      d.style.fontSize = `${18 + Math.random() * 26}px`;
      el.appendChild(d);
      anime({ targets: d, translateY: [-60, window.innerHeight + 80], rotate: anime.random(-360, 360), duration: 2600 + Math.random() * 2200, easing: "linear", complete: () => d.remove() });
    }, 260);

    // Periodic sparkle bursts off her hands.
    const bursts = window.setInterval(() => {
      const r = hero.current?.getBoundingClientRect();
      if (!r) return;
      burstSparkles(r.left + r.width * 0.18, r.top + r.height * 0.6, 12);
      burstSparkles(r.left + r.width * 0.55, r.top + r.height * 0.55, 12);
    }, 1720);

    return () => {
      intro.pause();
      bob.pause();
      wobble.pause();
      window.clearInterval(rain);
      window.clearInterval(bursts);
    };
  }, []);

  const pop = (e: React.MouseEvent) => {
    if (reducedMotion()) return;
    burstSparkles(e.clientX, e.clientY, 28);
    anime({ targets: hero.current, scale: [1.08, 1], duration: 500, easing: "easeOutElastic(1, .5)" });
  };

  return (
    <div className="nf-root" ref={root}>
      <div className="nf-rays" aria-hidden />
      <div className="nf-strobe" aria-hidden />

      <main className="nf-stage">
        <h1 className="nf-digits" aria-label="404">
          {["4", "0", "4"].map((c, i) => (
            <span key={i} data-c={c}>{c}</span>
          ))}
        </h1>

        <div className="nf-hero" ref={hero} onClick={pop}>
          <img src={gangImg} alt={t("notFound.alt")} draggable={false} />
          <span className="nf-shades" aria-hidden>🕶️</span>
          {STICKERS.map((s, i) => (
            <span key={s} className={`nf-sticker nf-sticker-${i}`} aria-hidden>{s}</span>
          ))}
        </div>

        <div className="nf-copy">
          <h2><T k="notFound.title" /></h2>
          <p><T k="notFound.body" vars={{ path: window.location.pathname }} /></p>
        </div>
        <a className="nf-home" href="/"><T k="notFound.home" /></a>
      </main>
    </div>
  );
}
