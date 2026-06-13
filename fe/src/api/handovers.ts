import { request } from './client'
import type { Handover, HandoverCreate } from '../types'

export function listHandovers(deviceId?: string, fromUserId?: string, toUserId?: string) {
  const params = new URLSearchParams()
  if (deviceId) params.set('device_id', deviceId)
  if (fromUserId) params.set('from_user_id', fromUserId)
  if (toUserId) params.set('to_user_id', toUserId)
  const query = params.toString()
  return request<Handover[]>(`/handovers${query ? `?${query}` : ''}`)
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

export function deleteHandover(handoverId: string) {
  return request<void>(`/handovers/${encodeURIComponent(handoverId)}`, {
    method: 'DELETE',
  })
}
