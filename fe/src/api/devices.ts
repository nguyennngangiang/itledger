// Device API calls — one function per endpoint. Components import these
// instead of calling fetch() directly. Template to clone for users.ts etc.
import { request } from './client'
import type { Device, DeviceCreate } from '../types'
import { pageQuery } from './paging'
import type { Paged, PageParams } from './paging'

// NOTE: there is no semanticSearchDevices here any more. The Smart-search UI was
// removed in favour of as-you-type filtering (usePagedList). The backend endpoint
// GET /devices/semantic-search still exists — Ask AI calls the same ranking path
// internally as its `semantic_search` tool (be/routers/assistant.py).

export function listDevices(userId?: string) {
  const query = userId ? `?user_id=${encodeURIComponent(userId)}` : ''
  return request<Device[]>(`/devices${query}`)
}

export function pageDevices(params: PageParams) {
  return request<Paged<Device>>(`/devices/page?${pageQuery(params)}`)
}

export function searchDevices(q: string) {
  return request<Device[]>(`/devices/search?q=${encodeURIComponent(q)}`)
}

// { column -> values already in use }, for the device form's autocompletes.
// Case variants ("Asus"/"ASUS") are collapsed server-side to the common one.
export function deviceSuggestions() {
  return request<Record<string, string[]>>('/devices/suggestions')
}

export function restoreDevice(serialNumber: string) {
  return request<Device>('/devices/restore', {
    method: 'POST',
    body: JSON.stringify({ serial_number: serialNumber }),
  })
}

export function getDevice(serialNumber: string) {
  return request<Device>(`/devices/${encodeURIComponent(serialNumber)}`)
}

export function createDevice(device: DeviceCreate) {
  return request<Device>('/devices', {
    method: 'POST',
    body: JSON.stringify(device),
  })
}

export function updateDevice(serialNumber: string, patch: Partial<Device>) {
  return request<Device>(`/devices/${encodeURIComponent(serialNumber)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// Backend deletes devices by payload (soft-delete). `permanent` purges from trash.
export function deleteDevice(serialNumber: string, permanent = false) {
  return request<void>(`/devices${permanent ? '?permanent=true' : ''}`, {
    method: 'DELETE',
    body: JSON.stringify({ serial_number: serialNumber }),
  })
}

// Bulk delete by serial number (soft-delete, or purge when permanent).
export function deleteDevicesBatch(serials: string[], permanent = false) {
  return request<void>(`/devices/batch${permanent ? '?permanent=true' : ''}`, {
    method: 'DELETE',
    body: JSON.stringify(serials),
  })
}

export type ImportResult = { inserted: number; skipped: number; total: number }

// Bulk import parsed rows (xlsx/csv). Existing serials are skipped server-side.
export function importDevices(devices: DeviceCreate[]) {
  return request<ImportResult>('/devices/import', {
    method: 'POST',
    body: JSON.stringify(devices),
  })
}
