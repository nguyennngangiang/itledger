// One drop zone for every kind of import, and for any number of files at once.
//
// Pressing "Import" in the header lands here with nothing chosen: you give it files
// and it works out what each one IS, then walks you through them one at a time.
// Picking a kind from the header's dropdown skips detection.
//
// Detection is deliberately explainable and reversible. The server answers from
// keyword/header heuristics first — no LLM, no cost, and a reason you can read
// ("found a BIEN BAN BAN GIAO heading") — and only asks the model when the headers are
// ambiguous. Whatever it decides is shown with a kind picker on the row, so a wrong
// guess costs one click instead of sending data down the wrong importer.
//
// Two things make a bulk run bearable. Detection runs one file at a time rather than
// firing five requests at a model that answers slowly; and the text the server
// extracted while detecting is kept and handed to the reader, so a scanned record is
// OCR'd once instead of twice — that second extract was most of the wait.
//
// Each file is still its own transaction. A folder of records where the third one is
// a mess should import the other four, not roll all five back.
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Segmented, Spin, Tag } from "antd";
import { detectImportKind } from "../../api/imports";
import { ApiError } from "../../api/client";
import { fileToAttachment } from "../../lib/files";
import { fileToSheetText } from "../../lib/sheetText";
import { newId } from "../../lib/id";
import { CheckIcon, UploadIcon, XIcon } from "../icons";
import { Modal } from "./Modal";
import { ImportDevicesModal } from "./ImportDevicesModal";
import { ImportMaintenanceModal } from "./ImportMaintenanceModal";
import { ImportHandoverModal } from "./ImportHandoverModal";
import { useT } from "../../i18n/useT";
import type { Key } from "../../i18n/catalog";

/** The kinds a caller can ask for directly (i.e. everything but "unknown"). */
export type ImportKind = "device_list" | "maintenance_list" | "handover_minutes";

const SHEET_EXT = ["xlsx", "xls", "csv"];
const ACCEPT = ".xlsx,.xls,.csv,.pdf,image/*";
const MAX_FILES = 12;

const KIND_LABEL: Record<ImportKind, Key> = {
  device_list: "importKind.device_list",
  maintenance_list: "importKind.maintenance_list",
  handover_minutes: "importKind.handover_minutes",
};

const PICKABLE: ImportKind[] = [
  "handover_minutes",
  "device_list",
  "maintenance_list",
];

type QueueStatus = "waiting" | "detecting" | "ready" | "reviewing" | "done" | "error";

type Queued = {
  id: string;
  file: File;
  kind: ImportKind | null;
  reason: string;
  usedLlm: boolean;
  /** Text the server already extracted while detecting — reused by the reader. */
  sourceText?: string;
  status: QueueStatus;
  /** What happened once it was applied, or why it failed. `issues` is a flag and
   * not something read back out of `text`: the summary used to branch on
   * `text.includes("cần xử lý")`, which quietly breaks the moment that sentence is
   * translated. Text is for reading; flags are for deciding. */
  outcome?: { text: string; issues?: boolean };
};

export function ImportModal({
  kind,
  onClose,
  onDone,
  initialFile,
}: {
  /** "auto" = detect from the file. Anything else skips straight to that importer. */
  kind: ImportKind | "auto";
  onClose: () => void;
  onDone?: () => void;
  /** A file already in hand — e.g. handed over from the Ask AI chat. */
  initialFile?: File;
}) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const patch = (id: string, next: Partial<Queued>) =>
    setQueue((q) => q.map((f) => (f.id === id ? { ...f, ...next } : f)));

  const add = (picked: File[]) => {
    setError(null);
    setFinished(false);
    setQueue((q) => {
      const room = MAX_FILES - q.length;
      if (picked.length > room) {
        setError(t("iq.tooMany", { max: MAX_FILES }));
      }
      return [
        ...q,
        ...picked.slice(0, Math.max(0, room)).map((file) => ({
          id: newId(),
          file,
          // A kind chosen in the header applies to everything dropped.
          kind: kind === "auto" ? null : kind,
          reason: kind === "auto" ? "" : t("iq.kindByYou"),
          usedLlm: false,
          status: (kind === "auto" ? "waiting" : "ready") as QueueStatus,
        })),
      ];
    });
  };

  useEffect(() => {
    if (initialFile) add([initialFile]);
    // The file identity is the trigger, not the recreated `add`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  // Detect one file at a time. Firing them all at once at a model that answers in
  // seconds gets the whole batch queued behind each other anyway, and a row that
  // says it is working while nothing is happening is a lie.
  useEffect(() => {
    if (kind !== "auto") return;
    const next = queue.find((f) => f.status === "waiting");
    if (!next || queue.some((f) => f.status === "detecting")) return;

    let cancelled = false;
    (async () => {
      patch(next.id, { status: "detecting" });
      try {
        const ext = next.file.name.split(".").pop()?.toLowerCase() ?? "";
        const source = SHEET_EXT.includes(ext)
          ? { sheet_text: await fileToSheetText(next.file) }
          : { attachment: await fileToAttachment(next.file) };
        const result = await detectImportKind(source);
        if (cancelled) return;
        patch(next.id, {
          kind: result.kind === "unknown" ? null : (result.kind as ImportKind),
          reason: result.reason,
          usedLlm: result.used_llm,
          sourceText: result.source_text,
          status: "ready",
        });
      } catch (e) {
        if (cancelled) return;
        patch(next.id, {
          status: "error",
          outcome: {
            text:
              e instanceof ApiError ? e.message : t("iq.err.detect"),
          },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queue, kind, t]);

  const detecting = queue.some(
    (f) => f.status === "detecting" || f.status === "waiting",
  );
  const reviewable = queue.filter((f) => f.status === "ready" && f.kind);
  const unknown = queue.filter((f) => f.status === "ready" && !f.kind);
  const applied = queue.filter((f) => f.status === "done");

  const activeFile = useMemo(
    () => queue.find((f) => f.id === current) ?? null,
    [queue, current],
  );

  /** Move to the next file that still needs reviewing, or show the summary. */
  const advance = (afterId: string) => {
    const rest = queue.filter(
      (f) => f.id !== afterId && f.status === "ready" && f.kind,
    );
    if (rest.length) {
      setCurrent(rest[0].id);
      patch(rest[0].id, { status: "reviewing" });
    } else {
      setCurrent(null);
      setFinished(true);
    }
  };

  const startReview = (id: string) => {
    setCurrent(id);
    patch(id, { status: "reviewing" });
  };

  const beginQueue = () => {
    if (reviewable.length) startReview(reviewable[0].id);
  };

  const skipFile = (id: string) => {
    patch(id, { status: "done", outcome: { text: t("iq.outcome.skipped") } });
    advance(id);
  };

  const finishFile = (id: string, outcome: Queued["outcome"]) => {
    patch(id, { status: "done", outcome });
    onDone?.();
    advance(id);
  };

  // ------------------------------------------------------------------ review

  if (activeFile && activeFile.kind) {
    const nth = queue.findIndex((f) => f.id === activeFile.id) + 1;
    const position =
      queue.length > 1
        ? t("iq.position", {
            nth,
            total: queue.length,
            name: activeFile.file.name,
          })
        : undefined;
    const shared = {
      file: activeFile.file,
      embedded: true as const,
      queueLabel: position,
      onClose: () => skipFile(activeFile.id),
    };
    return (
      <Modal
        title={t(KIND_LABEL[activeFile.kind])}
        onClose={() => skipFile(activeFile.id)}
        width={880}
      >
        {activeFile.kind === "handover_minutes" ? (
          <ImportHandoverModal
            {...shared}
            sourceText={activeFile.sourceText}
            onDone={(result) =>
              finishFile(activeFile.id, {
                text: result
                  ? t(
                      result.issues_logged ? "hi.toast.doneIssues" : "hi.toast.done",
                      {
                        handovers: result.handovers_created,
                        devices: result.devices_created,
                        users: result.users_created,
                        issues: result.issues_logged,
                      },
                    )
                  : t("iq.outcome.imported"),
                issues: !!result?.issues_logged,
              })
            }
          />
        ) : activeFile.kind === "maintenance_list" ? (
          <ImportMaintenanceModal
            {...shared}
            onDone={(summary) =>
              finishFile(activeFile.id, { text: summary ?? t("iq.outcome.imported") })
            }
          />
        ) : (
          <ImportDevicesModal
            {...shared}
            onDone={(summary) =>
              finishFile(activeFile.id, { text: summary ?? t("iq.outcome.imported") })
            }
          />
        )}
      </Modal>
    );
  }

  // ----------------------------------------------------------------- summary

  if (finished) {
    const withIssues = applied.filter((f) => f.outcome?.issues);
    return (
      <Modal title={t("iq.done.title")} onClose={onClose} width={620}>
        <div className="modal-form">
          <div className="import-queue">
            {queue.map((f) => (
              <div className="import-queue-row" key={f.id}>
                <span className="import-queue-icon is-done">
                  <CheckIcon size={14} />
                </span>
                <span className="import-queue-name">{f.file.name}</span>
                <span className="text-faint">{f.outcome?.text ?? "—"}</span>
              </div>
            ))}
          </div>
          {withIssues.length > 0 && (
            <Alert
              type="info"
              showIcon
              message={t("iq.left.title")}
              description={t("iq.left.body")}
            />
          )}
          <div className="modal-actions">
            <Button type="primary" onClick={onClose}>
              {t("iq.close")}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  // ------------------------------------------------------------------- queue

  return (
    <Modal title={t("iq.title")} onClose={onClose} width={680}>
      <div className="modal-form">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            if (picked.length) add(picked);
            e.target.value = "";
          }}
        />

        <div
          className={`import-zone${dragging ? " is-dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const picked = Array.from(e.dataTransfer.files ?? []);
            if (picked.length) add(picked);
          }}
        >
          <button type="button" onClick={() => inputRef.current?.click()}>
            <UploadIcon size={26} />
            <b>{t("iq.drop")}</b>
            <span className="import-hint">
              {kind === "auto"
                ? t("iq.drop.auto")
                : t("iq.drop.fixed", { kind: t(KIND_LABEL[kind]) })}
            </span>
          </button>
        </div>

        {error && <Alert type="warning" showIcon message={error} />}

        {queue.length > 0 && (
          <div className="import-queue">
            {queue.map((f) => (
              <div className="import-queue-row" key={f.id}>
                <span
                  className={`import-queue-icon${
                    f.status === "error" ? " is-error" : ""
                  }`}
                >
                  {f.status === "detecting" ? (
                    <Spin size="small" />
                  ) : f.status === "error" ? (
                    <XIcon size={14} />
                  ) : f.status === "done" ? (
                    <CheckIcon size={14} />
                  ) : (
                    <UploadIcon size={14} />
                  )}
                </span>
                <span className="import-queue-name">{f.file.name}</span>

                {f.status === "detecting" && (
                  <span className="text-faint">{t("iq.status.detecting")}</span>
                )}
                {f.status === "waiting" && (
                  <span className="text-faint">{t("iq.status.waiting")}</span>
                )}
                {f.status === "error" && (
                  <span className="text-faint">{f.outcome?.text}</span>
                )}
                {f.status === "done" && (
                  <span className="text-faint">{f.outcome?.text}</span>
                )}

                {(f.status === "ready" || f.status === "error") && (
                  <>
                    <Segmented
                      size="small"
                      value={f.kind ?? undefined}
                      onChange={(v) =>
                        patch(f.id, {
                          kind: v as ImportKind,
                          status: "ready",
                          reason: t("iq.kindByYou"),
                          outcome: undefined,
                        })
                      }
                      options={PICKABLE.map((k) => ({
                        value: k,
                        label: t(KIND_LABEL[k]),
                      }))}
                    />
                    {f.usedLlm && <Tag color="purple">AI</Tag>}
                  </>
                )}

                <Button
                  size="small"
                  type="text"
                  aria-label={t("iq.remove", { name: f.file.name })}
                  onClick={() => setQueue((q) => q.filter((x) => x.id !== f.id))}
                >
                  <XIcon size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Why it decided what it decided — one line, not one Alert per file. */}
        {reviewable.length === 1 && reviewable[0].reason && (
          <span className="import-hint">{reviewable[0].reason}</span>
        )}
        {unknown.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={t("iq.unknown", { n: unknown.length })}
          />
        )}

        <div className="modal-actions">
          <Button onClick={onClose}>{t("iq.cancel")}</Button>
          <Button
            type="primary"
            disabled={!reviewable.length || detecting}
            loading={detecting}
            onClick={beginQueue}
          >
            {detecting
              ? t("iq.detecting")
              : reviewable.length > 1
                ? t("iq.start.many", { n: reviewable.length })
                : t("iq.start")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
