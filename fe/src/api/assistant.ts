import { request } from './client'

// A prior chat turn, sent back so the assistant can resolve follow-up questions.
export type AssistantTurn = { role: 'user' | 'ai'; text: string }

// An uploaded file for the assistant to read: raw base64 bytes + name/mime. The
// backend forwards it to /rag/extract (parses xlsx/docx/pdf, OCRs images).
export type Attachment = { name: string; mime: string; data: string }

// Grounded, cross-resource Q&A over the fleet — answered by the internal LLM
// (be/llm), which calls backend tools to join devices/maintenance/handovers.
// `history` carries recent turns for multi-turn context; `attachments` are files
// the assistant reads (extracted server-side) and reasons over alongside the fleet.
export function askAssistant(
  question: string,
  history: AssistantTurn[] = [],
  attachments: Attachment[] = [],
) {
  return request<{ answer: string; tool_calls: string[]; elapsed_ms: number }>(
    '/assistant/ask',
    {
      method: 'POST',
      body: JSON.stringify({ question, history, attachments }),
    },
  )
}
