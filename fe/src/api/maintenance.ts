import { request } from './client'
import type { Maintenance, MaintenanceCreate } from '../types'
import { pageQuery } from './paging'
import type { Paged, PageParams } from './paging'

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

export function searchMaintenance(q: string) {
  return request<Maintenance[]>(`/maintenance/search?q=${encodeURIComponent(q)}`)
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
  return request<void>(`/maintenance/batch${permanent ? '?permanent=true' : ''}`, {
    method: 'DELETE',
    body: JSON.stringify(ids),
  })
}
