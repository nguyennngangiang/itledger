import { request } from './client'
import type { Maintenance, MaintenanceCreate } from '../types'

export function listMaintenance(deviceId?: string, team?: string) {
  const params = new URLSearchParams()
  if (deviceId) params.set('device_id', deviceId)
  if (team) params.set('team', team)
  const query = params.toString()
  return request<Maintenance[]>(`/maintenance${query ? `?${query}` : ''}`)
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

export function deleteMaintenance(maintenanceId: string) {
  return request<void>(`/maintenance/${encodeURIComponent(maintenanceId)}`, {
    method: 'DELETE',
  })
}
