import { deleteBatch, request } from './client'
import type { Maintenance, MaintenanceCreate } from '../types'
import { pageQuery } from './paging'
import type { Paged, PageParams } from './paging'

// Semantic search was dropped from the UI — see the note in devices.ts.

export function listMaintenance(deviceId?: string, team?: string) {
  const params = new URLSearchParams()
  if (deviceId) params.set('device_id', deviceId)
  if (team) params.set('team', team)
  const query = params.toString()
  return request<Maintenance[]>(`/maintenance${query ? `?${query}` : ''}`)
}

export function pageMaintenance(params: PageParams) {
  return request<Paged<Maintenance>>(`/maintenance/page?${pageQuery(params)}`)
}

// Bulk import parsed repair rows. Re-importing the same file is idempotent, and
// rows naming an unknown serial come back in `skipped` rather than failing the
// batch — see be/repositories/maintenance.import_maintenance.
export function importMaintenance(records: MaintenanceCreate[]) {
  return request<{ inserted: number; skipped: number; total: number }>(
    '/maintenance/import',
    { method: 'POST', body: JSON.stringify(records) },
  )
}

// { column -> values already used }, for the repair form's autocompletes, so
// it suggests the phrasing the team actually writes.
export function maintenanceSuggestions() {
  return request<Record<string, string[]>>('/maintenance/suggestions')
}

export function restoreMaintenance(maintenanceId: string) {
  return request<Maintenance>(
    `/maintenance/${encodeURIComponent(maintenanceId)}/restore`,
    { method: 'POST' },
  )
}

export function getMaintenance(maintenanceId: string) {
  return request<Maintenance>(`/maintenance/${encodeURIComponent(maintenanceId)}`)
}

export function createMaintenance(maintenance: MaintenanceCreate) {
  return request<Maintenance>('/maintenance', {
    method: 'POST',
    body: JSON.stringify(maintenance),
  })
}

export function updateMaintenance(maintenanceId: string, patch: Partial<Maintenance>) {
  return request<Maintenance>(`/maintenance/${encodeURIComponent(maintenanceId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteMaintenance(maintenanceId: string, permanent = false) {
  const query = permanent ? '?permanent=true' : ''
  return request<void>(
    `/maintenance/${encodeURIComponent(maintenanceId)}${query}`,
    { method: 'DELETE' },
  )
}

// Bulk delete by id (soft-delete, or purge when permanent).
export function deleteMaintenanceBatch(ids: string[], permanent = false) {
  return deleteBatch('maintenance', ids, permanent)
}
