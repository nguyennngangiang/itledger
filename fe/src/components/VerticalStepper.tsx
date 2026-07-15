export type StepperNode = {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  avatarLabel?: string;
  tone?: "default" | "danger" | "accent" | "success" | "current";
  badge?: string;
};

/** Shared vertical timeline primitive. `variant="stepper"` is a fixed,
 * numbered sequence (e.g. Problem → Solution → Result); `variant="rail"` is a
 * dynamic chain of avatar-initial nodes (e.g. a device's handover history),
 * with the last/"current" node highlighted. */
export function VerticalStepper({
  nodes,
  variant,
}: {
  nodes: StepperNode[];
  variant: "stepper" | "rail";
}) {
  return (
    <div className={`v-stepper v-stepper-${variant}`}>
      {nodes.map((n, i) => (
        <div
          className={`v-stepper-item tone-${n.tone ?? "default"}`}
          key={n.id}
        >
          <div className="v-stepper-marker-col">
            <span className="v-stepper-marker">
              {variant === "rail" ? n.avatarLabel ?? "?" : i + 1}
            </span>
            {i < nodes.length - 1 && <span className="v-stepper-line" />}
          </div>
          <div className="v-stepper-body">
            <div className="v-stepper-title">
              {n.title}
              {n.badge && <span className="journey-current-badge">{n.badge}</span>}
            </div>
            {n.subtitle && <div className="v-stepper-sub">{n.subtitle}</div>}
            {n.meta && <div className="v-stepper-meta">{n.meta}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
