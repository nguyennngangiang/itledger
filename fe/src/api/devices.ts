// Device API calls — one function per endpoint. Components import these
// instead of calling fetch() directly. Template to clone for users.ts etc.
import { request } from './client'
import type { Device, DeviceCreate } from '../types'

export function listDevices(userId?: string) {
  const query = userId ? `?user_id=${encodeURIComponent(userId)}` : ''
  return request<Device[]>(`/devices${query}`)
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

export function deleteDevice(serialNumber: string) {
  return request<void>(`/devices/${encodeURIComponent(serialNumber)}`, {
    method: 'DELETE',
  })
}
