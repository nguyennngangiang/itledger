import { useEffect, useRef } from "react";
import { Button } from "antd";
import anime from "animejs";
import { TrashIcon } from "./icons";
import { useT } from "../i18n/useT";

/**
 * Selection action bar shared by every table screen. Shows how many rows are
 * selected and offers a bulk delete + clear. Slides/pops in via anime.js when
 * it mounts (i.e. when the first row gets selected).
 */
export function BulkDeleteBar({
  count,
  trashed = false,
  onDelete,
  onClear,
}: {
  count: number;
  trashed?: boolean;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      anime({
        targets: ref.current,
        translateY: [-10, 0],
        opacity: [0, 1],
        scale: [0.96, 1],
        duration: 380,
        easing: "easeOutBack",
      });
    }
  }, []);

  return (
    <div className="bulk-bar" ref={ref}>
      <span className="bulk-bar-count">
        {t("bulk.selected", { n: count })}
      </span>
      <div className="bulk-bar-actions">
        <Button size="small" onClick={onClear}>
          {t("bulk.clear")}
        </Button>
        <Button
          size="small"
          danger
          type="primary"
          icon={<TrashIcon size={15} />}
          onClick={onDelete}
        >
          {t(trashed ? "bulk.deleteForever" : "bulk.delete")}
        </Button>
      </div>
    </div>
  );
}
