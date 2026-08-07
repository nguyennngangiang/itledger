import { useEffect, useRef } from "react";
import anime from "animejs";
import { useT } from "../i18n/useT";

/**
 * Cute trash-bin toggle that replaces the Active/Trash segmented control.
 * Click to "open" the bin (switch to the trash view); click again — or the
 * "Back" label — to close it and return to the active list. The lid lifts on a
 * hinge and the whole bin gives a springy bounce via anime.js.
 */
export function TrashToggle({
  trashed,
  onToggle,
}: {
  trashed: boolean;
  onToggle: (trashed: boolean) => void;
}) {
  const { t } = useT();
  const lidRef = useRef<SVGGElement>(null);
  const binRef = useRef<SVGSVGElement>(null);
  const first = useRef(true);

  useEffect(() => {
    const lid = lidRef.current;
    const bin = binRef.current;
    if (!lid || !bin) return;

    // On first paint just set the resting lid position — no animation.
    if (first.current) {
      first.current = false;
      lid.style.transform = trashed ? "rotate(-38deg) translateX(-1px)" : "none";
      return;
    }

    anime.remove(lid);
    anime.remove(bin);

    if (trashed) {
      // Open: flip the lid up and pop the bin with a happy little bounce.
      anime({
        targets: lid,
        rotate: [0, -38],
        translateX: [0, -1],
        translateY: [0, -1],
        duration: 560,
        easing: "easeOutBack",
      });
      anime({
        targets: bin,
        scale: [1, 1.22, 1],
        translateY: [0, -4, 0],
        rotate: [0, -8, 4, 0],
        duration: 680,
        easing: "easeOutElastic(1, 0.55)",
      });
    } else {
      // Close: drop the lid back down with a soft settle.
      anime({
        targets: lid,
        rotate: [-38, 0],
        translateX: [-1, 0],
        translateY: [-1, 0],
        duration: 480,
        easing: "easeInOutBack",
      });
      anime({
        targets: bin,
        scale: [1, 0.88, 1],
        duration: 440,
        easing: "easeOutElastic(1, 0.7)",
      });
    }
  }, [trashed]);

  return (
    <button
      type="button"
      className={`trash-toggle${trashed ? " open" : ""}`}
      onClick={() => onToggle(!trashed)}
      title={t(trashed ? "trash.toActive" : "trash.toTrash")}
      aria-pressed={trashed}
    >
      <svg
        ref={binRef}
        className="trash-toggle-icon"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.85}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Lid + handle — hinged at the left edge so it lifts like a real lid. */}
        <g
          ref={lidRef}
          className="trash-lid"
          style={{ transformBox: "fill-box", transformOrigin: "left center" }}
        >
          <path d="M3 6h18" />
          <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" />
        </g>
        {/* Can body + inner lines. */}
        <path d="M5.5 6.5l.9 12.8A2 2 0 0 0 8.4 21h7.2a2 2 0 0 0 2-1.7l.9-12.8" />
        <path d="M10 11v5M14 11v5" />
      </svg>
      <span className="trash-toggle-label">{t(trashed ? "trash.back" : "trash.trash")}</span>
    </button>
  );
}
