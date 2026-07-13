import { useState } from "react";
import { Button, Input } from "antd";
import { toast } from "react-toastify";
import { Modal } from "./Modal";
import { askAssistant } from "../../api/assistant";
import { SparklesIcon } from "../icons";

type Msg = { role: "user" | "ai"; text: string };

const SUGGESTIONS = [
  "Which laptops are oldest and due for replacement?",
  "How many devices is each team assigned?",
  "List the devices repaired the most.",
  "What's in stock and unassigned right now?",
];

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
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const ask = async (question: string) => {
    const query = question.trim();
    if (!query || loading) return;
    setMsgs((m) => [...m, { role: "user", text: query }]);
    setQ("");
    setLoading(true);
    try {
      const { answer } = await askAssistant(query);
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
        <div className="assistant-log">
          {msgs.length === 0 && (
            <div className="assistant-empty">
              <SparklesIcon size={22} />
              <p>
                Ask anything about your devices. Answers are computed from your
                live inventory by the internal LLM — grounded in your fleet's own
                data.
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
        <div className="assistant-input">
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
