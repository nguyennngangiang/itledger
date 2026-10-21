import { useEffect, useRef, useState } from "react";
import type { Device } from "../types";
import { reduceMotion, weakMachine } from "../lib/perf";
import { useT } from "../i18n/useT";

/**
 * Turnable 3D model of a device, shown in the row's info popover. The three.js
 * scene code is its own chunk (import() on mount) and everything is disposed on
 * unmount — the popover uses destroyOnHidden, so closing it frees the GPU.
 * No WebGL, or the context is lost: render nothing; the spec list still shows.
 */
export function Device3D({ device }: { device: Device }) {
  const { t } = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  const peek = useRef<{ toggleLid(): boolean; hasLid: boolean; dispose(): void } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [hasLid, setHasLid] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("../lib/device3d/scene")
      .then(({ mount }) => {
        if (cancelled || !ref.current) return;
        peek.current = mount(ref.current, device, {
          still: reduceMotion() || weakMachine(),
          onLost: () => setState("failed"),
        });
        setHasLid(peek.current.hasLid);
        setState("ready");
      })
      .catch(() => !cancelled && setState("failed"));
    return () => {
      cancelled = true;
      peek.current?.dispose();
      peek.current = null;
    };
  }, [device]);

  if (state === "failed") return null;
  return (
    <figure className={`device-3d${state === "loading" ? " is-loading" : ""}`}>
      <canvas
        ref={ref}
        onDoubleClick={() => peek.current?.toggleLid()}
        aria-label={t("device3d.label", { label: device.name ?? device.serial_number })}
        role="img"
      />
      <figcaption>{t(hasLid ? "device3d.hintLid" : "device3d.hint")}</figcaption>
    </figure>
  );
}
