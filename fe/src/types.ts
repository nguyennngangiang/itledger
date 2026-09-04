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
  status: DeviceStatus | null
}

// Device lifecycle status (stored on the backend `devices.status` column).
export type DeviceStatus = "active" | "in_stock" | "maintaining" | "on_del"

// Single ghost account (IT team) that owns every ownerless / in-stock device.
export const GHOST_USER_CODE = "IT-STORE"

// Display metadata for each status: label + indicator-light color + pill class.
export const DEVICE_STATUS_META: Record<
  DeviceStatus,
  { label: string; color: string; pill: string }
> = {
  active: { label: "Active", color: "#34d399", pill: "pill-success" },
  in_stock: { label: "In stock", color: "#94a3b8", pill: "pill-neutral" },
  maintaining: { label: "Maintaining", color: "#fbbf24", pill: "pill-warning" },
  on_del: { label: "On-del", color: "#f87171", pill: "pill-danger" },
}

export const DEVICE_STATUS_ORDER: DeviceStatus[] = [
  "active",
  "in_stock",
  "maintaining",
  "on_del",
]

// Fields accepted when creating a device (serial_number required, rest optional).
export type DeviceCreate = Pick<Device, 'serial_number'> & Partial<Omit<Device, 'serial_number'>>

/** Employment status. Separate from the trash — see the note on User.status. */
export type UserStatus = "active" | "retired"

export type User = {
  employee_code: string
  name: string | null
  team: string | null
  // "active" | "retired". Employment status, NOT the trash — someone who has
  // left keeps their row so their handover history reads and so the machines
  // they never returned stay chaseable.
  status?: UserStatus | null
}

export type UserCreate = Pick<User, 'employee_code'> & Partial<Omit<User, 'employee_code'>>
export type UserCreateBatch = UserCreate[]

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

// Team names are NOT enumerated here. There is no teams table; the real list
// lives in users.team (~67 values and growing) and is served by
// GET /users/teams — see listUserTeams() in api/users.ts. A hardcoded list
// used to sit here and matched almost none of the actual departments.
