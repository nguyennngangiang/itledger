// Smart-search relevance feedback — the "mark this result right" signal that
// trains / steers the LLM reranker. One function per endpoint.
import { request } from './client'

export type FeedbackCreate = {
  query: string
  device_id?: string
  document?: string
  score?: number
  label?: number // 1 = right / relevant, 0 = not relevant
}

export function markFeedback(fb: FeedbackCreate) {
  return request('/feedback', {
    method: 'POST',
    body: JSON.stringify({ label: 1, ...fb }),
  })
}

export function feedbackStats() {
  return request<{ total: number }>('/feedback/stats')
}
