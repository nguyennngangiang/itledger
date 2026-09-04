import { BulkDeleteBar } from "./BulkDeleteBar";
import type { Key } from "../i18n/catalog";
import { useT } from "../i18n/useT";

/**
 * The bar above every table: the panel's title on the left, and on the right
 * either the row count or — once anything is selected — the bulk-delete bar.
 *
 * This was character-identical in all four screens. The title flips to "Trash"
 * with the view rather than being passed in twice, since every caller did that.
 */
export function PanelHead({
  title,
  trashed,
  total,
  selectedCount,
  onBulkDelete,
  onClearSelection,
}: {
  /** Catalog key for the active view's title; the trash view uses panel.trash.
   *  Typed as Key, not string, so a mistyped title fails the build. */
  title: Key;
  trashed: boolean;
  total: number;
  selectedCount: number;
  onBulkDelete: () => void;
  onClearSelection: () => void;
}) {
  const { t } = useT();
  return (
    <div className="panel-head">
      <span className="panel-title">{t(trashed ? "panel.trash" : title)}</span>
      {selectedCount > 0 ? (
        <BulkDeleteBar
          count={selectedCount}
          trashed={trashed}
          onDelete={onBulkDelete}
          onClear={onClearSelection}
        />
      ) : (
        <span className="panel-count">{t("panel.total", { n: total })}</span>
      )}
    </div>
  );
}
