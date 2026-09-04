import { useEffect, useRef } from "react";
import anime from "animejs";

/** Animated number that counts up to `value` whenever it changes. */
export function CountUp({ value, duration = 1400 }: { value: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const prev = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obj = { n: prev.current };
    // The span renders empty and this effect owns its text from here on. Putting
    // the starting number in the JSX instead meant reading a ref during render,
    // and there is nothing to read it for: anime overwrites the text on its first
    // frame anyway.
    el.textContent = String(obj.n);
    anime({
      targets: obj,
      n: value,
      round: 1,
      duration,
      easing: "easeOutExpo",
      update: () => {
        el.textContent = String(obj.n);
      },
    });
    prev.current = value;
    return () => anime.remove(obj);
  }, [value, duration]);

  return <span ref={ref} />;
}
