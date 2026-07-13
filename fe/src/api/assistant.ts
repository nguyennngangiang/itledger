import { request } from './client'

// Grounded Q&A over the fleet — answered by the internal LLM (be/llm).
export function askAssistant(question: string) {
  return request<{ answer: string }>('/assistant/ask', {
    method: 'POST',
    body: JSON.stringify({ question }),
  })
}

// One-liner explaining why a record matched a smart-search query (proof card).
export function explainMatch(query: string, document: string) {
  return request<{ explanation: string }>('/assistant/explain', {
    method: 'POST',
    body: JSON.stringify({ query, document }),
  })
}
