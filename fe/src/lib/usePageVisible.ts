// Whether the tab is on screen. Scanning stops completely while it is not —
// camera track off, no OCR — and resumes when it comes back: a backgrounded
// tab that keeps the camera and the GPU busy is the first one iOS kills.
import { useEffect, useState } from "react";

export function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    window.addEventListener("pagehide", on);
    return () => {
      document.removeEventListener("visibilitychange", on);
      window.removeEventListener("pagehide", on);
    };
  }, []);
  return visible;
}

/** Next delay for a loop that should run at most `fps` times a second, and
 * slower when its last pass was slow — a phone that needs 300 ms a frame gets
 * a frame every 450 ms, not a queue of them. */
export function paced(fps: number, lastMs: number) {
  return Math.max(1000 / fps, lastMs * 1.5);
}
