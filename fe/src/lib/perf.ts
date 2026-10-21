// Shared "go easy on this machine" checks for anything that animates on the GPU
// (SparkleBackground, the 3D device preview).

export const reduceMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** ≤4 cores or ≤4 GB: the office's older laptops. They get still frames, not loops. */
export function weakMachine(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (navigator.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
}
