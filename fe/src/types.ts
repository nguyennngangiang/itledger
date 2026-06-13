// Shared types mirroring the backend response models (be/models/*).
// Keep field names in sync with the API's snake_case JSON.

export type Device = {
  serial_number: string
  barcode: string | null
  type: string | null
  brand: string | null
  cpu: string | null
  ram: string | null
  storage: string | null
  os: string | null
  msoffice: string | null
  buy_date: string | null // ISO date string, e.g. "2026-06-11"
  name: string | null
  user_id: string | null
}

// Fields accepted when creating a device (serial_number required, rest optional).
export type DeviceCreate = Pick<Device, 'serial_number'> & Partial<Omit<Device, 'serial_number'>>

export type User = {
  employee_code: string
  name: string | null
  team: string | null
}

export type UserCreate = Pick<User, 'employee_code'> & Partial<Omit<User, 'employee_code'>>

export type Team = {
  team_id: string
  team_name: string | null
  division: string | null
}

export type Maintenance = {
  maintenance_id: string
  maintenance_date: string | null
  device_id: string | null
  team: string | null
  part: string | null
  reason: string | null
  solution: string | null
  result: string | null
  cost_vnd: number | null
  remarks: string | null
}

export type MaintenanceCreate = Pick<Maintenance, 'maintenance_id'> &
  Partial<Omit<Maintenance, 'maintenance_id'>>

export type Handover = {
  handover_id: string
  handover_date: string | null
  device_id: string | null
  from_user_id: string | null
  to_user_id: string | null
  reason: string | null
}

export type HandoverCreate = Pick<Handover, 'handover_id'> &
  Partial<Omit<Handover, 'handover_id'>>
