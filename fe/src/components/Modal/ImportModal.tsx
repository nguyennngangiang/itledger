// One drop zone for every kind of import, and for any number of files at once.
//
// Pressing "Import" in the header lands here with nothing chosen: you give it files
// and it works out what each one IS, then walks you through them one at a time.
// Picking a kind from the header's dropdown skips detection. Files dragged anywhere
// in the window arrive here too — see lib/useFileDrop.ts and `incoming` below.
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
//
// The queue is a card per file rather than a table row per file, because a file in a
// bulk run has a story and not a value: what we think it is, why we think that, how
// far along it is, and what it did. That did not fit on one line, and squeezing it
// there is what made this screen read as a progress-less list of filenames.
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Progress, Segmented, Tag, Tooltip } from "antd";
import { detectImportKindStreaming } from "../../api/imports";
import type { DetectProgress } from "../../api/imports";
import { ApiError } from "../../api/client";
import { fileToAttachment } from "../../lib/files";
import { fileToSheetText } from "../../lib/sheetText";
import { newId } from "../../lib/id";
import { animateEntrance } from "../../lib/sparkle";
import {
  CheckIcon,
  DeviceIcon,
  HandoverIcon,
  SparklesIcon,
  UploadIcon,
  WrenchIcon,
  XIcon,
} from "../icons";
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

/** Each kind gets the same glyph it has in the top nav, so "this is a handover
 * record" is legible before anyone reads the label. */
const KIND_GLYPH: Record<ImportKind, typeof DeviceIcon> = {
  device_list: DeviceIcon,
  maintenance_list: WrenchIcon,
  handover_minutes: HandoverIcon,
};

const PICKABLE: ImportKind[] = [
  "handover_minutes",
  "device_list",
  "maintenance_list",
];

/** Phases a detection reports, and how far along each one is. `extract` is the only
 * slow one — an OCR pass on a scan — so it owns most of the bar's travel. */
const DETECT_PHASE: Record<"extract" | "matching" | "asking", { key: Key; at: number }> =
  {
    extract: { key: "iq.phase.extract", at: 30 },
    matching: { key: "iq.phase.matching", at: 75 },
    asking: { key: "iq.phase.asking", at: 88 },
  };

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
  /** Where its detection has got to. Cleared once the file is classified. */
  progress?: DetectProgress;
  /** What happened once it was applied, or why it failed. `issues` and `skipped`
   * are flags and not something read back out of `text`: the summary used to branch
   * on `text.includes("cần xử lý")`, which quietly breaks the moment that sentence
   * is translated. Text is for reading; flags are for deciding. */
  outcome?: { text: string; issues?: boolean; skipped?: boolean };
};

/** "24 KB". Size is on the card because it is the one cue that tells a 40-row sheet
 * from a scanned photo before anything has been read. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  return (name.split(".").pop() ?? "").toUpperCase();
}

export function ImportModal({
  kind,
  onClose,
  onDone,
  incoming,
}: {
  /** "auto" = detect from the file. Anything else skips straight to that importer. */
  kind: ImportKind | "auto";
  onClose: () => void;
  onDone?: () => void;
  /** Files handed in from outside — dragged onto the window, or passed over from
   * the Ask AI chat. `at` is the trigger rather than the array, so a second drop
   * onto an already-open dialog appends instead of being mistaken for no change. */
  incoming?: { files: File[]; at: number } | null;
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
    if (incoming?.files.length) add(incoming.files);
    // The batch's timestamp is the trigger; `add` is recreated every render, and
    // the array is a fresh object each time even when nothing was dropped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.at]);

  // Detect one file at a time. Firing them all at once at a model that answers in
  // seconds gets the whole batch queued behind each other anyway, and a row that
  // says it is working while nothing is happening is a lie.
  useEffect(() => {
    if (kind !== "auto") return;
    const next = queue.find((f) => f.status === "waiting");
    if (!next || queue.some((f) => f.status === "detecting")) return;

    let cancelled = false;
    (async () => {
      patch(next.id, { status: "detecting", progress: undefined });
      try {
        const ext = next.file.name.split(".").pop()?.toLowerCase() ?? "";
        const source = SHEET_EXT.includes(ext)
          ? { sheet_text: await fileToSheetText(next.file) }
          : { attachment: await fileToAttachment(next.file) };
        const result = await detectImportKindStreaming(source, (progress) => {
          if (!cancelled) patch(next.id, { progress });
        });
        if (cancelled) return;
        patch(next.id, {
          kind: result.kind === "unknown" ? null : (result.kind as ImportKind),
          reason: result.reason,
          usedLlm: result.used_llm,
          sourceText: result.source_text,
          status: "ready",
          progress: undefined,
        });
      } catch (e) {
        if (cancelled) return;
        patch(next.id, {
          status: "error",
          progress: undefined,
          outcome: {
            text: e instanceof ApiError ? e.message : t("iq.err.detect"),
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

  // Cards rise in as they are added — but ONLY the new ones. Animating the whole
  // list on every addition would fade the cards already on screen back from zero
  // opacity, so dropping a sixth file made the first five blink.
  const animated = useRef(new Set<string>());
  useEffect(() => {
    const fresh = queue.filter((f) => !animated.current.has(f.id));
    if (!fresh.length) return;
    fresh.forEach((f) => animated.current.add(f.id));
    const nodes = fresh
      .map((f) =>
        document.querySelector<HTMLElement>(`[data-file-id="${f.id}"]`),
      )
      .filter((node): node is HTMLElement => !!node);
    if (nodes.length) animateEntrance(nodes, 45);
  }, [queue]);

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
    patch(id, {
      status: "done",
      // Flagged, not inferred from the text: the summary counts what actually went
      // in, and "4 files imported" must not include the one you closed unread.
      outcome: { text: t("iq.outcome.skipped"), skipped: true },
    });
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
    const imported = applied.filter((f) => !f.outcome?.skipped);
    const skipped = applied.length - imported.length;
    return (
      <Modal title={t("iq.done.title")} onClose={onClose} width={640}>
        <div className="modal-form">
          {/* One number leads, the files explain it. A bulk run's result is "four
              records went in", not a list of twelve equal lines. */}
          <div className="import-tally">
            <span className="import-tally-n">{imported.length}</span>
            <span className="import-tally-text">
              <b>{t("iq.done.count", { n: imported.length })}</b>
              {(withIssues.length > 0 || skipped > 0) && (
                <span className="import-tally-sub">
                  {[
                    withIssues.length > 0 &&
                      t("iq.done.someIssues", { n: withIssues.length }),
                    skipped > 0 && t("iq.done.someSkipped", { n: skipped }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </span>
          </div>
          <div className="import-files">
            {queue.map((f) => (
              <div className="import-file is-done" key={f.id}>
                <span
                  className={`import-file-glyph${
                    f.outcome?.skipped ? "" : " is-ok"
                  }`}
                >
                  {f.outcome?.skipped ? <XIcon size={16} /> : <CheckIcon size={16} />}
                </span>
                <div className="import-file-body">
                  <div className="import-file-top">
                    <span className="import-file-name">{f.file.name}</span>
                  </div>
                  <div className="import-file-meta">{f.outcome?.text ?? "—"}</div>
                </div>
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

        {/* The drop target. It has no `onDrop` of its own: the window-level handler
            in lib/useFileDrop.ts catches every drop in the app, including the ones
            landing here, so a second handler would add each file twice. What is
            left is the highlight — the part that tells you this is a target. */}
        <div
          className={`import-zone${dragging ? " is-dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={() => setDragging(false)}
        >
          <button type="button" onClick={() => inputRef.current?.click()}>
            <span className="import-zone-glyph">
              <UploadIcon size={26} />
            </span>
            <b>{t("iq.drop")}</b>
            <span className="import-hint">
              {kind === "auto"
                ? t("iq.drop.auto")
                : t("iq.drop.fixed", { kind: t(KIND_LABEL[kind]) })}
            </span>
            <span className="import-zone-formats">
              {["XLSX", "CSV", "PDF", t("iq.format.image")].map((f) => (
                <span className="import-format" key={f}>
                  {f}
                </span>
              ))}
            </span>
          </button>
        </div>

        {error && <Alert type="warning" showIcon message={error} />}

        {queue.length > 0 && (
          <div className="import-files">
            {queue.map((f) => (
              <FileCard
                key={f.id}
                file={f}
                onKind={(k) =>
                  patch(f.id, {
                    kind: k,
                    status: "ready",
                    reason: t("iq.kindByYou"),
                    outcome: undefined,
                  })
                }
                onRemove={() => setQueue((q) => q.filter((x) => x.id !== f.id))}
              />
            ))}
          </div>
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

/** One queued file, as a card: what it is, why we think so, how far along, and the
 * one click that overrules us. */
function FileCard({
  file,
  onKind,
  onRemove,
}: {
  file: Queued;
  onKind: (kind: ImportKind) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const Glyph = file.kind ? KIND_GLYPH[file.kind] : UploadIcon;
  const settled = file.status === "ready" || file.status === "error";
  const phase =
    file.progress &&
    file.progress.phase !== "done" &&
    file.progress.phase !== "error"
      ? file.progress
      : null;

  return (
    <div
      // Read by the entrance animation, which only animates cards it has not seen.
      data-file-id={file.id}
      className={`import-file${file.status === "error" ? " is-error" : ""}${
        file.status === "done" ? " is-done" : ""
      }`}
    >
      <span
        className={`import-file-glyph${
          file.status === "error"
            ? " is-bad"
            : file.status === "done"
              ? " is-ok"
              : file.kind
                ? " is-known"
                : ""
        }`}
      >
        {file.status === "error" ? (
          <XIcon size={16} />
        ) : file.status === "done" ? (
          <CheckIcon size={16} />
        ) : (
          <Glyph size={16} />
        )}
      </span>

      <div className="import-file-body">
        <div className="import-file-top">
          <span className="import-file-name">{file.file.name}</span>
          {file.usedLlm && (
            <Tooltip title={t("iq.byAi")}>
              <Tag color="purple" bordered={false}>
                <SparklesIcon size={11} /> AI
              </Tag>
            </Tooltip>
          )}
        </div>

        <div className="import-file-meta">
          <span>{extensionOf(file.file.name)}</span>
          <span>·</span>
          <span>{fileSize(file.file.size)}</span>
          {/* Why we think it is what it think it is — the whole reason detection is
              allowed to be confident. */}
          {settled && file.reason && (
            <>
              <span>·</span>
              <span className="import-file-why">{file.reason}</span>
            </>
          )}
          {file.status === "waiting" && (
            <>
              <span>·</span>
              <span>{t("iq.status.waiting")}</span>
            </>
          )}
          {file.status === "done" && file.outcome && (
            <>
              <span>·</span>
              <span>{file.outcome.text}</span>
            </>
          )}
        </div>

        {/* Shown for the whole of `detecting`, not just once the server has spoken.
            The first stretch is the browser's own work — flattening a workbook or
            base64-ing a PDF — and on a large file that is a visible pause with no
            event to announce it. */}
        {file.status === "detecting" && (
          <div className="import-file-progress">
            <Progress
              percent={phase ? DETECT_PHASE[phase.phase].at : 8}
              showInfo={false}
              size="small"
              status="active"
              strokeColor="var(--accent)"
            />
            <span className="import-file-phase">
              {t(phase ? DETECT_PHASE[phase.phase].key : "iq.phase.opening")}
            </span>
          </div>
        )}

        {settled && (
          <div className="import-file-pick">
            <Segmented
              size="small"
              value={file.kind ?? undefined}
              onChange={(v) => onKind(v as ImportKind)}
              options={PICKABLE.map((k) => ({
                value: k,
                label: t(KIND_LABEL[k]),
              }))}
            />
          </div>
        )}
      </div>

      {file.status !== "done" && (
        <Button
          size="small"
          type="text"
          className="import-file-x"
          aria-label={t("iq.remove", { name: file.file.name })}
          onClick={onRemove}
        >
          <XIcon size={14} />
        </Button>
      )}
    </div>
  );
}
