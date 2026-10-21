// Ask AI. Upload documents once and keep asking about them, PLUS ask about the
// live fleet (devices/handovers/maintenance) in the same chat — distinct from
// the retired fleet-wide Ask AI panel, which only ever read a file for the one
// question it rode in on (git show 96003dc~1:fe/src/components/Modal/
// AssistantModal.tsx, kept only as a UI reference, not restored; that feature
// is fully gone today — no button, no route, no code).
//
// Always server-side (api/askAi.ts `askDocumentsStreaming`, backed by
// be/routers/documents.py — the backend keeps the "documents" name; it's the
// data model, not the button): answering a fleet question needs a live tool
// call against Postgres, which a browser can't do itself, so there is no
// client-side/WebLLM path here — every question, document or fleet, goes
// through the one server-side agentic call. Streamed as SSE because a
// multi-round fleet-tool loop on this host's CPU-only Ollama can genuinely
// take a while; the tool-call trace under a reply is what tells a visitor
// "still working on it" instead of "hung".
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input } from "antd";
import { toast } from "react-toastify";
import {
  askDocumentsStreaming,
  deleteDocument,
  listDocuments,
  uploadDocument,
  type ChunkHit,
  type DocumentItem,
} from "../api/askAi";
import { ApiError } from "../api/client";
import { fileToAttachment } from "../lib/files";
import { useSessionState } from "../lib/useSessionState";
import { getSessionId } from "../lib/session";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { FileTextIcon, SparklesIcon, TrashIcon, UploadIcon } from "./icons";
import { useT } from "../i18n/useT";

type Msg = {
  role: "user" | "ai";
  text: string;
  sources?: ChunkHit[];
  toolCalls?: string[];
};

const ACCEPT = ".txt,.md,.csv,.tsv,.json,.log,.yaml,.yml,.xlsx,.docx,.pdf,text/*";
const MAX_SIZE = 20 * 1024 * 1024; // matches be/routers/documents.py MAX_UPLOAD_BYTES

// How many recent turns ride along so a follow-up ("what about its
// handovers?") can resolve — trimmed the same way the retired panel did.
const MAX_HISTORY = 8;

export function AskAiScreen() {
  const { t } = useT();
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentItem | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persisted per browser-tab session, same pattern the retired fleet-wide Ask
  // AI panel used (useSessionState + getSessionId) — survives a reload, gone
  // when the tab closes.
  const [msgs, setMsgs] = useSessionState<Msg[]>(
    `itledger.askai.chat.${getSessionId()}`,
    [],
  );
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);

  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      setDocs(await listDocuments());
    } catch {
      toast.error(t("askAi.err.list"));
    } finally {
      setDocsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    // loadDocs raises the loading flag before it awaits, which the compiler
    // rule reads as a synchronous setState — intentional, same as
    // NotificationScreen's `load`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDocs();
  }, [loadDocs]);

  const upload = async (files: File[]) => {
    setUploading(true);
    let ok = 0;
    for (const file of files) {
      if (file.size > MAX_SIZE) {
        toast.error(t("askAi.err.tooBig", { name: file.name }));
        continue;
      }
      try {
        const att = await fileToAttachment(file);
        await uploadDocument(att.name, att.mime, att.data);
        ok += 1;
      } catch (e) {
        toast.error(t("askAi.err.upload", { name: file.name, error: String(e) }));
      }
    }
    setUploading(false);
    if (ok) loadDocs();
  };

  const onPick = (list: FileList | null) => {
    if (!list?.length) return;
    upload(Array.from(list));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeDoc = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteDocument(target.id);
    } catch (e) {
      // Already gone (a stale list, a double click) — the outcome the user
      // wanted is already true, so drop it from view same as a real delete
      // rather than leaving a row that will 404 every time it's tried again.
      if (!(e instanceof ApiError && e.status === 404)) {
        toast.error(String(e));
        return;
      }
    }
    setDocs((d) => d.filter((x) => x.id !== target.id));
  };

  // All three update whichever message is currently last — the placeholder
  // pushed right alongside the user's turn, before the answer starts arriving.
  const appendPiece = (piece: string) =>
    setMsgs((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, text: last.text + piece };
      return next;
    });

  const appendToolCall = (name: string) =>
    setMsgs((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, toolCalls: [...(last.toolCalls ?? []), name] };
      return next;
    });

  const setLastSources = (sources: ChunkHit[]) =>
    setMsgs((m) => {
      const next = [...m];
      next[next.length - 1] = { ...next[next.length - 1], sources };
      return next;
    });

  const ask = async (question: string) => {
    const query = question.trim();
    if (!query || asking) return;
    const history = msgs.slice(-MAX_HISTORY).map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: "user", text: query }, { role: "ai", text: "" }]);
    setQ("");
    setAsking(true);
    try {
      await askDocumentsStreaming(
        { question: query, top_k: 6, history },
        (progress) => {
          if (progress.phase === "tool_call") appendToolCall(progress.tool);
          if (progress.phase === "sources") setLastSources(progress.sources);
          if (progress.phase === "answering") appendPiece(progress.piece);
        },
      );
    } catch (e) {
      toast.error(String(e));
      setMsgs((m) => [...m.slice(0, -1), { role: "ai", text: t("askAi.err.ask") }]);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="askai-screen split-view">
      <section className="askai-library panel">
        <div className="askai-library-header">
          <h2>{t("askAi.library.title")}</h2>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(e) => onPick(e.target.files)}
          />
          <Button
            icon={<UploadIcon size={15} />}
            loading={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {t("askAi.upload")}
          </Button>
        </div>

        {/* Local drop zone, not the window-wide one App.tsx installs for the
            importer — stopPropagation keeps a file dropped here from also
            opening the unrelated import wizard. */}
        <div
          className={`askai-dropzone${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            e.stopPropagation();
            setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragging(false);
            onPick(e.dataTransfer.files);
          }}
        >
          <UploadIcon size={20} />
          <span>{t("askAi.dropHint")}</span>
        </div>

        <div className="askai-list">
          {docsLoading && <p className="askai-empty">{t("common.loading")}</p>}
          {!docsLoading && docs.length === 0 && (
            <p className="askai-empty">{t("askAi.library.empty")}</p>
          )}
          {docs.map((d) => (
            <div key={d.id} className="askai-item">
              <FileTextIcon size={16} />
              <span className="askai-item-title" title={d.filename}>
                {d.title}
              </span>
              <span className="askai-item-meta">
                {t("askAi.chars", { n: d.char_count.toLocaleString() })}
              </span>
              <button
                className="askai-item-remove"
                aria-label={t("askAi.remove")}
                onClick={() => setDeleteTarget(d)}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="askai-chat panel">
        <div className="askai-log">
          {msgs.length === 0 && (
            <div className="askai-chat-empty">
              <SparklesIcon size={22} />
              <p>{t("askAi.chat.intro")}</p>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`askai-msg ${m.role}`}>
              <div className="askai-bubble">
                {m.text || (asking && i === msgs.length - 1 ? "…" : "")}
              </div>
              {m.role === "ai" && !!m.toolCalls?.length && (
                <div className="askai-trace">
                  {m.toolCalls.map((name, j) => (
                    <span key={j} className="askai-trace-chip">
                      {name}
                    </span>
                  ))}
                </div>
              )}
              {m.role === "ai" && !!m.sources?.length && (
                <div className="askai-sources">
                  {m.sources.map((s, j) => (
                    <span key={j} className="askai-source-chip" title={s.chunk_text}>
                      {s.title}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {msgs.length > 0 && (
          <div className="askai-chat-bar">
            <Button size="small" onClick={() => setMsgs([])} disabled={asking}>
              {t("askAi.newChat")}
            </Button>
          </div>
        )}

        <div className="askai-input">
          <Input.TextArea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("askAi.placeholder")}
            autoSize={{ minRows: 1, maxRows: 4 }}
            disabled={asking}
            onPressEnter={(e) => {
              e.preventDefault();
              ask(q);
            }}
          />
          <Button
            type="primary"
            loading={asking}
            onClick={() => ask(q)}
            icon={<SparklesIcon size={16} />}
          >
            {t("askAi.ask")}
          </Button>
        </div>
      </section>

      {deleteTarget && (
        <ConfirmModal
          message={t("askAi.confirmDelete", { name: deleteTarget.title })}
          onConfirm={removeDoc}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
