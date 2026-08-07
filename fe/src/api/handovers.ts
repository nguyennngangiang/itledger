import { request } from './client'
import type { Handover, HandoverCreate } from '../types'
import { pageQuery } from './paging'
import type { Paged, PageParams } from './paging'

// Semantic search was dropped from the UI — see the note in devices.ts.

export function listHandovers(deviceId?: string, fromUserId?: string, toUserId?: string) {
  const params = new URLSearchParams()
  if (deviceId) params.set('device_id', deviceId)
  if (fromUserId) params.set('from_user_id', fromUserId)
  if (toUserId) params.set('to_user_id', toUserId)
  const query = params.toString()
  return request<Handover[]>(`/handovers${query ? `?${query}` : ''}`)
}

export function pageHandovers(params: PageParams) {
  return request<Paged<Handover>>(`/handovers/page?${pageQuery(params)}`)
}

// { column -> values already used }, for the handover form's Reason autocomplete,
// so it offers the wording the team actually writes and not only a fixed list.
export function handoverSuggestions() {
  return request<Record<string, string[]>>('/handovers/suggestions')
}

export function restoreHandover(handoverId: string) {
  return request<Handover>(
    `/handovers/${encodeURIComponent(handoverId)}/restore`,
    { method: 'POST' },
  )
}

export function getHandover(handoverId: string) {
  return request<Handover>(`/handovers/${encodeURIComponent(handoverId)}`)
}

export function createHandover(handover: HandoverCreate) {
  return request<Handover>('/handovers', {
    method: 'POST',
    body: JSON.stringify(handover),
  })
}

export function updateHandover(handoverId: string, patch: Partial<Handover>) {
  return request<Handover>(`/handovers/${encodeURIComponent(handoverId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteHandover(handoverId: string, permanent = false) {
  const query = permanent ? '?permanent=true' : ''
  return request<void>(
    `/handovers/${encodeURIComponent(handoverId)}${query}`,
    { method: 'DELETE' },
  )
}

// Bulk delete by id (soft-delete, or purge when permanent).
export function deleteHandoversBatch(ids: string[], permanent = false) {
  return request<void>(`/handovers/batch${permanent ? '?permanent=true' : ''}`, {
    method: 'DELETE',
    body: JSON.stringify(ids),
  })
}
