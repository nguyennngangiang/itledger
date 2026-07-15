import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Drawer, Input } from "antd";
import { toast } from "react-toastify";
import { askAssistant } from "../../api/assistant";
import { listDevices } from "../../api/devices";
import { countByStatus } from "../../lib/deviceStats";
import type { Device } from "../../types";
import { fileToAttachment } from "../../lib/files";
import { SparklesIcon, UploadIcon } from "../icons";
import { useSessionState } from "../../lib/useSessionState";
import { getSessionId } from "../../lib/session";

type Msg = {
  role: "user" | "ai";
  text: string;
  toolCalls?: string[];
  elapsedMs?: number;
};

const SUGGESTIONS = [
  "Which laptops are oldest and due for replacement?",
  "How many devices is each team assigned?",
  "List the devices repaired the most.",
  "What's in stock and unassigned right now?",
];

// Files the assistant can read (via the server's /rag/extract): images, PDF,
// Word, Excel, CSV, plain text.
const ACCEPT = "image/*,.pdf,.docx,.xlsx,.csv,.txt";
const ALLOWED_EXT = ["pdf", "docx", "xlsx", "csv", "txt"];
const MAX_FILES = 6;
const MAX_SIZE = 15 * 1024 * 1024; // 15 MB

function isAccepted(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ALLOWED_EXT.includes(ext);
}

// Grounded Q&A over the fleet, answered by the internal LLM (RAG). A
// right-docked panel (not a small popover) so it can sit alongside the
// underlying screen; the conversation persists across closing/reopening.
export function AssistantModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  // Persist the conversation for this browser-tab session, so it survives page
  // reloads and navigating away from the Devices tab (this modal remounts). A new
  // tab / closing the tab starts a fresh session.
  const [msgs, setMsgs] = useSessionState<Msg[]>(
    `itledger.assistant.chat.${getSessionId()}`,
    [],
  );
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Live fleet counts for the trust strip ("exact counts — computed, never
  // guessed") — fetched fresh each time the panel opens.
  useEffect(() => {
    if (!open) return;
    listDevices().then(setDevices).catch(() => {});
  }, [open]);

  const statusCounts = useMemo(() => countByStatus(devices), [devices]);

  const addFiles = (picked: FileList | null) => {
    if (!picked) return;
    const next = [...files];
    for (const f of Array.from(picked)) {
      if (!isAccepted(f)) {
        toast.error(`Không hỗ trợ định dạng: ${f.name}`);
        continue;
      }
      if (f.size > MAX_SIZE) {
        toast.error(`File quá lớn (>15MB): ${f.name}`);
        continue;
      }
      if (next.length >= MAX_FILES) {
        toast.error(`Tối đa ${MAX_FILES} file mỗi lần.`);
        break;
      }
      next.push(f);
    }
    setFiles(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (i: number) =>
    setFiles((fs) => fs.filter((_, idx) => idx !== i));

  const ask = async (question: string) => {
    const query = question.trim();
    if ((!query && files.length === 0) || loading) return;
    // Send recent turns so follow-ups ("what about its handovers?") resolve.
    const history = msgs.slice(-8);
    const pending = files;
    const labels = pending.map((f) => `📎 ${f.name}`).join("\n");
    const bubble = [query, labels].filter(Boolean).join("\n");
    setMsgs((m) => [...m, { role: "user", text: bubble }]);
    setQ("");
    setFiles([]);
    setLoading(true);
    try {
      const attachments = await Promise.all(pending.map(fileToAttachment));
      const { answer, tool_calls, elapsed_ms } = await askAssistant(
        query || "Đọc và tóm tắt file đính kèm.",
        history,
        attachments,
      );
      setMsgs((m) => [
        ...m,
        {
          role: "ai",
          text: answer,
          toolCalls: tool_calls ?? [],
          elapsedMs: elapsed_ms ?? 0,
        },
      ]);
    } catch (e) {
      toast.error("Assistant failed: " + e);
      setMsgs((m) => [
        ...m,
        {
          role: "ai",
          text:
            "⚠️ The AI service is unavailable. Check that the internal LLM endpoint is reachable.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Drawer
      title="Ask AI — grounded in your fleet"
      placement="right"
      size={460}
      open={open}
      onClose={onClose}
      className="assistant-drawer"
      destroyOnHidden={false}
    >
      <div className="assistant">
        <div className="assistant-stats-strip">
          <span className="assistant-stat-pill">{devices.length} devices</span>
          <span className="assistant-stat-pill">
            {statusCounts.maintaining} maintaining
          </span>
          <span className="assistant-stat-pill">{statusCounts.on_del} on-del</span>
          <span className="assistant-stat-caption">
            exact counts — computed, never guessed
          </span>
        </div>

        {msgs.length > 0 && (
          <div className="assistant-bar">
            <Button size="small" onClick={() => setMsgs([])} disabled={loading}>
              New chat
            </Button>
          </div>
        )}
        <div className="assistant-log">
          {msgs.length === 0 && (
            <div className="assistant-empty">
              <SparklesIcon size={22} />
              <p>
                Ask anything about your devices, or attach a file (image, PDF,
                Word, Excel…) and I'll read it and answer — grounded in your
                fleet's own data.
              </p>
              <div className="assistant-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    className="assistant-chip"
                    onClick={() => ask(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`assistant-msg ${m.role}`}>
              <div className="assistant-bubble">{m.text}</div>
              {m.role === "ai" && !!m.toolCalls?.length && (
                <div className="assistant-trace">
                  {m.toolCalls.map((t, j) => (
                    <span className="assistant-trace-chip" key={j}>
                      {t}
                    </span>
                  ))}
                  <span className="assistant-trace-meta">
                    {m.toolCalls.length} tool call{m.toolCalls.length === 1 ? "" : "s"}
                    {m.elapsedMs ? ` · ${(m.elapsedMs / 1000).toFixed(1)}s` : ""}
                  </span>
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="assistant-msg ai">
              <div className="assistant-bubble assistant-thinking">
                thinking…
              </div>
            </div>
          )}
        </div>
        {files.length > 0 && (
          <div className="assistant-files">
            {files.map((f, i) => (
              <span key={i} className="assistant-file-chip" title={f.name}>
                📎 {f.name}
                <button
                  className="assistant-file-x"
                  onClick={() => removeFile(i)}
                  aria-label={`Remove ${f.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="assistant-input">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => addFiles(e.target.files)}
          />
          <Button
            icon={<UploadIcon size={16} />}
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || files.length >= MAX_FILES}
            title="Attach files (image, PDF, Word, Excel…)"
          />
          <Input.TextArea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Which Dell machines are over 5 years old?"
            autoSize={{ minRows: 1, maxRows: 4 }}
            onPressEnter={(e) => {
              e.preventDefault();
              ask(q);
            }}
          />
          <Button
            type="primary"
            loading={loading}
            onClick={() => ask(q)}
            icon={<SparklesIcon size={16} />}
          >
            Ask
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
