// Local-LLM assistant — grounded Q&A over the device inventory (RAG).
import { request } from './client'

export function askAssistant(question: string) {
  return request<{ answer: string }>('/assistant/ask', {
    method: 'POST',
    body: JSON.stringify({ question }),
  })
}
