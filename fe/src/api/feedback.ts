import { request } from './client'

// A "this result is right" mark from the smart-search proof card. Stored in this
// project's DB and used only as few-shot to steer the LLM reranker (project-local
// learning — the shared model is never trained). `resource` scopes it to a screen.
export type FeedbackCreate = {
  resource: 'devices' | 'maintenance' | 'handovers'
  item_id: string
  query: string
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
