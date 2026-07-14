import { useRef, useState } from "react";
import { Button, Input } from "antd";
import { toast } from "react-toastify";
import { Modal } from "./Modal";
import { askAssistant } from "../../api/assistant";
import { fileToAttachment } from "../../lib/files";
import { SparklesIcon, UploadIcon } from "../icons";
import { useSessionState } from "../../lib/useSessionState";
import { getSessionId } from "../../lib/session";

type Msg = { role: "user" | "ai"; text: string };

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

// Grounded Q&A over the fleet, answered by the internal LLM (RAG). Kept mounted so
// the conversation survives closing/reopening; renders nothing while closed.
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

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
      const { answer } = await askAssistant(query || "Đọc và tóm tắt file đính kèm.", history, attachments);
      setMsgs((m) => [...m, { role: "ai", text: answer }]);
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
    <Modal title="Ask AI — grounded in your fleet" onClose={onClose}>
      <div className="assistant">
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
    </Modal>
  );
}
