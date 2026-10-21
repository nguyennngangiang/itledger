// API for the "Ask AI" page (components/AskAiScreen.tsx): upload a document
// once, then chat — grounded in the document library AND the live fleet
// (devices/handovers/maintenance) in the same conversation. Backed by
// be/routers/documents.py, which keeps the "documents" name — it's the data
// model/API, not the button the user clicks.
import { ApiError, request, streamRequest } from './client'

export type DocumentItem = {
  id: number
  title: string
  filename: string
  mime: string | null
  uploaded_at: string
  char_count: number
  status: string
}

export type ChunkHit = {
  document_id: number
  title: string
  chunk_text: string
  score: number
}

// A prior chat turn, sent back so a follow-up ("what about its handovers?")
// can resolve — same shape components/AskAiScreen.tsx keeps client-side.
export type ChatTurn = { role: 'user' | 'ai'; text: string }

export type AskQuery = {
  question: string
  document_id?: number | null
  top_k?: number
  history?: ChatTurn[]
}

export function listDocuments() {
  return request<DocumentItem[]>('/documents')
}

export function uploadDocument(name: string, mime: string, data: string) {
  return request<DocumentItem>('/documents', {
    method: 'POST',
    body: JSON.stringify({ name, mime, data }),
  })
}

export function deleteDocument(id: number) {
  return request<void>(`/documents/${id}`, { method: 'DELETE' })
}

/** Retrieval only, no LLM call — a standalone "what would match" lookup. Not
 * used by the chat UI, which does its own retrieval server-side as part of
 * `/documents/ask`; kept for direct API use. */
export function searchDocuments(query: AskQuery) {
  return request<{ chunks: ChunkHit[] }>('/documents/search', {
    method: 'POST',
    body: JSON.stringify(query),
  })
}

/** One step of the chat in flight. See be/routers/documents.py `_ask_events`:
 * `tool_call` arrives once per live fleet-database lookup the model makes
 * (find_devices / device_history / semantic_search — document retrieval isn't
 * one of these, it always runs up front); `answering` arrives once per
 * generated piece, same shape as the handover reader's stream in
 * api/imports.ts. */
export type AskProgress =
  | { phase: 'thinking' }
  | { phase: 'tool_call'; tool: string }
  | { phase: 'sources'; sources: ChunkHit[] }
  | { phase: 'answering'; piece: string }
  | { phase: 'done'; result: { answer: string; sources: ChunkHit[]; tool_calls: string[] } }
  | { phase: 'error'; status: number; detail: string }

/** The Ask AI chat: document context + live fleet tool calls, one answer,
 * streamed as SSE. Always server-side (this host's Ollama) — answering may
 * need a live tool call against Postgres, which a browser can't make itself.
 * Resolves with the finished answer; `onProgress` gets every step as it
 * streams in. */
export async function askDocumentsStreaming(
  query: AskQuery,
  onProgress: (progress: AskProgress) => void,
): Promise<{ answer: string; sources: ChunkHit[]; tool_calls: string[] }> {
  const events = streamRequest<AskProgress>('/documents/ask', {
    body: JSON.stringify(query),
  })
  for await (const event of events) {
    onProgress(event)
    if (event.phase === 'done') return event.result
    if (event.phase === 'error') throw new ApiError(event.status, event.detail)
  }
  throw new ApiError(503, 'The answer ended without a result.')
}
