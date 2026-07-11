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

  return <span ref={ref}>{prev.current}</span>;
}
