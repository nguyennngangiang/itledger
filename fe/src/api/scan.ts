// Scan screen: Claude reads paperwork / device labels (be/routers/scan.py), and
// the reviewed serials are saved as in-stock devices. Barcodes are decoded in
// the browser (lib/barcode.ts) and never pass through here.
import { request } from './client'
import type { Attachment } from '../lib/files'

export type ScanGroup = {
  name: string
  model_name?: string
  type: string
  brand: string
  cpu: string
  ram: string
  storage: string
  os: string
  warranty_months?: number
  serials: string[]
  unsure?: string[]
  quantity?: number
  missing?: number
}

export type SkippedLine = ScanGroup & { kind: string; reason: string }

export type ScanReading = {
  vendor: string
  doc_type: string
  doc_number: string
  doc_date: string
  items: ScanGroup[]
  skipped: SkippedLine[]
  duplicates: string[]
  existing: string[]
}

export type ScanStatus = { claude: boolean; model: string; learned: number }

export type SaveResult = {
  inserted: number
  skipped: number
  total: number
  existing: string[]
  learned: boolean
}

export const getScanStatus = () => request<ScanStatus>('/scan/status')

export const readScan = (file: Attachment, mode: 'document' | 'label') =>
  request<ScanReading>('/scan/read', {
    method: 'POST',
    body: JSON.stringify({ ...file, mode }),
  })

export const saveScan = (body: {
  vendor: string
  doc_type: string
  buy_date: string | null
  groups: ScanGroup[]
  original: { items: ScanGroup[] } | null
}) =>
  request<SaveResult>('/scan/save', { method: 'POST', body: JSON.stringify(body) })

// ---------------------------------------------------------------- minutes

export type MinutesParty = {
  label: string
  role: 'giver' | 'receiver' | 'buyer' | 'seller' | 'unknown'
  name: string
  code: string
  dept: string
  position: string
  company: string
  address: string
  phone: string
}

export type MinutesItem = {
  no: string
  item: string
  detail: string
  serials: string[]
  quantity: number
  note: string
  kind: string
  type: string
  brand: string
  cpu: string
  ram: string
  storage: string
  os: string
  unsure: string[]
}

export type MinutesAnswer = {
  kind: 'internal' | 'supplier'
  doc_type: string
  doc_number: string
  handover_date: string
  place: string
  reason: string
  parties: MinutesParty[]
  items: MinutesItem[]
}

export type MinutesReading = {
  kind: 'internal' | 'supplier'
  answer: MinutesAnswer
  existing: string[]
  known_codes: Record<string, { name: string | null; team: string | null }>
  parsed?: import('./imports').ParsedMinutes
  reading?: ScanReading
}

/** Claude reads camera stills (or one file) of a handover record — be/routers/scan.py. */
export const readMinutes = (frames: { mime: string; data: string }[]) =>
  request<MinutesReading>('/scan/minutes/read', { method: 'POST', body: JSON.stringify({ frames }) })

/** After a corrected minutes record is saved: the server keeps what changed
 * from Claude's read as an example for next time. */
export function learnMinutes(form: import('../lib/minutesForm').MinutesForm, r: MinutesReading) {
  const val = (f?: { value: string }) => f?.value ?? ''
  const group = (name: string, serials: string[], x: Partial<Record<string, string>>) => ({ name, model_name: name, serials, ...x })
  return request<{ learned: boolean }>('/scan/learn', {
    method: 'POST',
    body: JSON.stringify({
      vendor: r.answer.parties.find((p) => p.role === 'seller')?.company ?? '',
      doc_type: r.answer.doc_type,
      original_items: r.answer.items.map((i) => group(i.item, i.serials, { type: i.type, brand: i.brand, cpu: i.cpu, ram: i.ram, storage: i.storage })),
      final_items: form.items.map((i) => group(val(i.item), i.serials, { type: val(i.type), brand: val(i.brand), cpu: val(i.cpu), ram: val(i.ram), storage: val(i.storage) })),
      original_parties: r.answer.parties,
      final_parties: form.parties.map((p) => ({ label: p.label, name: val(p.name), code: val(p.code), dept: val(p.dept), position: val(p.position), company: val(p.company) })),
    }),
  })
}
