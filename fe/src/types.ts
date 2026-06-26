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
  selected: boolean | false
}

export type UserCreate = Pick<User, 'employee_code'> & Partial<Omit<User, 'employee_code'>>
export type UserCreateBatch = UserCreate[]

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

export const teamsOptions = [
    { team_id: "ESG", team_name: "ESG" },
    { team_id: "DMD", team_name: "DMD" },
    { team_id: "PMD", team_name: "PMD" },
    { team_id: "FMD", team_name: "FMD" },
    { team_id: "PROJECT", team_name: "PROJECT" },
    { team_id: "MKT", team_name: "MKT" },
    { team_id: "HR", team_name: "HR" },
    { team_id: "ACC", team_name: "ACC" },
    { team_id: "FIN", team_name: "FIN" },
    { team_id: "ADMIN", team_name: "ADMIN" },
    { team_id: "IT", team_name: "IT" },
    { team_id: "S&P", team_name: "S&P" },
    { team_id: "QA/QC", team_name: "QA/QC" },
    { team_id: "KRDESK", team_name: "KRDESK" },
    { team_id: "OPD", team_name: "OPD" },
  ]; 
