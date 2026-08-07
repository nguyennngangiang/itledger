// Handover-minutes importer. Three calls, in order, and only the last one writes:
//   read  → file text → structured fields (verified against the file server-side)
//   plan  → fields → what would change, plus each line's inferred direction
//   apply → the decisions the user confirmed → one transaction
// Plus the import-issue log that backs the Notifications screen.
import { request } from './client'
import type { Attachment } from './assistant'
import type { Device, DeviceStatus, User } from '../types'

// Which way a line item moves. Decided by the backend from the ledger's own
// history, never by the LLM — see be/handover_import.decide_flow.
export type Flow = 'return' | 'issue' | 'transfer'

export type MinutesParty = {
  name: string | null
  code: string | null
  dept: string | null
  position: string | null
}

export type MinutesItem = {
  no: number | null
  item: string | null
  quantity: number | null
  detail: string | null
  serial: string
  note: string | null
  device: Partial<Record<'type' | 'brand' | 'cpu' | 'ram' | 'storage' | 'name', string | null>>
}

export type ParsedMinutes = {
  handover_date: string | null
  place: string | null
  party_a: MinutesParty
  party_b: MinutesParty
  items: MinutesItem[]
}

export type ReadResult = {
  parsed: ParsedMinutes
  warnings: string[]
  source_text: string
}

export type IssueKind =
  | 'user_created'
  | 'user_code_mismatch'
  | 'user_field_conflict'
  | 'device_created_incomplete'
  | 'device_field_conflict'
  | 'device_owner_mismatch'
  | 'handover_duplicate'
  | 'flow_ambiguous'

// One disagreement the importer will not settle on its own.
export type PlanIssue = {
  kind: IssueKind
  resource: string
  item_id: string | null
  payload: {
    label?: string
    code?: string
    name?: string
    serial?: string
    reason?: string
    guess?: Flow
    missing?: string[]
    team_suggestion?: string | null
    fields?: FieldConflict[]
    candidates?: User[]
    created_from?: Record<string, string | null>
    existing?: Record<string, unknown>
    proposed_date?: string | null
  }
}

export type FieldConflict = {
  field: string
  current: string | null
  proposed: string | null
}

export type UserPlan = {
  label: string
  code: string | null
  proposed: { name: string | null; team: string | null }
  team_suggestion: string | null
  current: User | null
  action: 'create' | 'update' | 'reuse' | 'skip'
  /** Values that fill a column the ledger has left empty. Written without asking —
   * an empty `team` is not a disagreement, and treating it as one is what
   * buried the Notifications screen. Contradictions still come back as issues. */
  fills: Record<string, string>
  issues: PlanIssue[]
}

export type ItemPlan = {
  no: number | null
  serial: string
  note: string | null
  detail: string | null
  flow: Flow
  flow_reason: string
  ambiguous: boolean
  duplicate_of: Record<string, unknown> | null
  from_user_id: string | null
  to_user_id: string | null
  device_owner_after: string | null
  device_status_after: DeviceStatus
  current_device: Device | null
  proposed_device: Record<string, string | null>
  device_action: 'create' | 'update' | 'reuse'
  /** Specs that fill blanks on the stored device — see UserPlan.fills. */
  device_fills: Record<string, string>
  issues: PlanIssue[]
}

export type HandoverPlan = {
  source_file: string | null
  handover_date: string | null
  place: string | null
  it_side: 'a' | 'b' | null
  it_reason: string
  it_code: string | null
  user_code: string | null
  users: UserPlan[]
  items: ItemPlan[]
  issue_count: number
}

export type ApplyResult = {
  users_created: number
  users_updated: number
  devices_created: number
  devices_updated: number
  handovers_created: number
  handovers_skipped: number
  issues_logged: number
}

export type ImportIssue = {
  id: number
  created_at: string
  source_file: string | null
  kind: IssueKind
  resource: string
  item_id: string | null
  payload: PlanIssue['payload']
  status: 'open' | 'resolved' | 'dismissed'
  resolved_at: string | null
  resolution: Record<string, unknown> | null
}

// Which importer a dropped file belongs to.
export type DetectedKind =
  | 'handover_minutes'
  | 'device_list'
  | 'maintenance_list'
  | 'unknown'

export type DetectResult = {
  kind: DetectedKind
  reason: string
  confident: boolean
  used_llm: boolean
  source_text: string
}

// Classify a dropped file. Keyword/header heuristics answer first and cost
// nothing; the LLM is only consulted when they are unsure (be/import_detect.py).
export function detectImportKind(source: { sheet_text?: string; attachment?: Attachment }) {
  return request<DetectResult>('/imports/detect', {
    method: 'POST',
    body: JSON.stringify(source),
  })
}

// A spreadsheet is flattened in the browser and sent as text; a PDF or photo has
// to go up as bytes so the server can extract (and OCR) it.
export function readHandoverMinutes(source: { sheet_text?: string; attachment?: Attachment }) {
  return request<ReadResult>('/imports/handover/read', {
    method: 'POST',
    body: JSON.stringify(source),
  })
}

export function planHandoverImport(
  parsed: ParsedMinutes,
  sourceFile?: string | null,
  itSide?: 'a' | 'b' | null,
) {
  return request<HandoverPlan>('/imports/handover/plan', {
    method: 'POST',
    body: JSON.stringify({ parsed, source_file: sourceFile, it_side: itSide }),
  })
}

export type UserDecision = {
  code: string
  action: 'create' | 'update' | 'reuse'
  name?: string | null
  team?: string | null
}

export type ItemDecision = {
  serial: string
  flow: Flow | 'skip'
  handover_id?: string
  handover_date?: string | null
  reason?: string | null
  create_device?: boolean
  device_fields?: Record<string, string | null>
}

export function applyHandoverImport(body: {
  source_file?: string | null
  handover_date?: string | null
  party_a_code?: string | null
  party_b_code?: string | null
  it_side?: 'a' | 'b' | null
  users: UserDecision[]
  items: ItemDecision[]
  issues: PlanIssue[]
}) {
  return request<ApplyResult>('/imports/handover/apply', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listImportIssues(status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open') {
  return request<ImportIssue[]>(`/imports/issues?status=${status}`)
}

export function countOpenIssues() {
  return request<{ open: number }>('/imports/issues/count')
}

// Close the open issues the ledger has already answered — a device whose missing
// specs were filled in from the Devices screen, a field conflict someone corrected
// on the person's own row, an issue naming a code that no longer exists. Called
// before listing so a job that was done days ago isn't still at the top.
export function recheckIssues() {
  return request<{ closed: number }>('/imports/issues/recheck', { method: 'POST' })
}

export function resolveImportIssue(
  id: number,
  status: 'resolved' | 'dismissed' | 'open',
  resolution?: Record<string, unknown>,
) {
  return request<ImportIssue>(`/imports/issues/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, resolution }),
  })
}
