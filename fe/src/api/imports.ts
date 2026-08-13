// Handover-minutes importer. Three calls, in order, and only the last one writes:
//   read  → file text → structured fields (verified against the file server-side)
//   plan  → fields → what would change, plus each line's inferred direction
//   apply → the decisions the user confirmed → one transaction
// Plus the import-issue log that backs the Notifications screen.
import { ApiError, request, streamRequest } from './client'
import type { Attachment } from './assistant'
import type { Device, DeviceStatus, User } from '../types'

// Which way a movement goes. Decided by the backend from ranked evidence — the
// ledger's own history, then the Ghi chú arrow — never by the LLM. See
// be/handover_direction.py.
export type Flow = 'return' | 'issue' | 'transfer'

// Where a direction came from, so a row can say why it points where it does.
export type DirectionSource =
  | 'recorded'
  | 'note'
  | 'transfer'
  | 'holder'
  | 'owner'
  | 'it'
  | 'unknown'

export type MinutesParty = {
  /** The form's own letter: "A", "B", "C" … */
  label: string
  name: string | null
  code: string | null
  dept: string | null
  position: string | null
}

export type MinutesItem = {
  /** The movement's identity — its position. NOT the serial: one record can move
   * the same device twice, and keying on the serial merges the two into one. */
  row: number
  no: number | null
  item: string | null
  quantity: number | null
  detail: string | null
  serial: string
  note: string | null
  device: Partial<Record<'type' | 'brand' | 'cpu' | 'ram' | 'storage' | 'name', string | null>>
}

// A record is N parties and M movements, not a pair and a list.
export type ParsedMinutes = {
  handover_date: string | null
  place: string | null
  parties: MinutesParty[]
  items: MinutesItem[]
}

export type ReadResult = {
  parsed: ParsedMinutes
  warnings: string[]
  source_text: string
  /** Who read it: `sheet` = the form parsed in plain code, `llm` = the model. */
  reader: 'sheet' | 'llm'
  /** Numbered rows the file's own item table has — the progress denominator. */
  item_rows: number
}

/** One step of a read in flight. See be/routers/imports.py `_read_events`.
 *
 * `loading` is the phase worth naming out loud: it is the model server pulling
 * llama3.1:8b into VRAM, which takes ~44s and produces no output at all, so a bare
 * spinner there is indistinguishable from a hang. */
export type ReadProgress =
  | { phase: 'extract'; name: string }
  | { phase: 'scanning'; total: number }
  | { phase: 'loading'; total: number }
  | { phase: 'reading'; items: number; total: number }
  | { phase: 'verifying'; total: number }
  | { phase: 'done'; result: ReadResult }
  | { phase: 'error'; status: number; detail: string }

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
    /** Which movement raised it — two rows can name one serial. */
    row?: number
    code?: string
    name?: string
    serial?: string
    reason?: string
    source?: DirectionSource
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
  row: number
  no: number | null
  serial: string
  note: string | null
  detail: string | null
  flow: Flow
  flow_reason: string
  direction_source: DirectionSource
  confident: boolean
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
  /** Index into `parties`, or null when no party is clearly the IT side. */
  it_index: number | null
  it_reason: string
  it_code: string | null
  parties: UserPlan[]
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

/** One step of a detection in flight. See be/routers/imports.py `_detect_events`.
 *
 * `extract` is the phase that needed reporting: for a PDF or a photo it is an OCR
 * pass that runs for tens of seconds, and it happens during DETECTION rather than
 * during the read (the extracted text is handed on, so a scan is never OCR'd
 * twice). A queue row spinning silently through it was the last unexplained wait. */
export type DetectProgress =
  | { phase: 'extract'; name: string }
  | { phase: 'matching' }
  | { phase: 'asking' }
  | { phase: 'done'; result: DetectResult }
  | { phase: 'error'; status: number; detail: string }

// Classify a dropped file. Keyword/header heuristics answer first and cost
// nothing; the LLM is only consulted when they are unsure (be/import_detect.py).
export function detectImportKind(source: { sheet_text?: string; attachment?: Attachment }) {
  return request<DetectResult>('/imports/detect', {
    method: 'POST',
    body: JSON.stringify(source),
  })
}

/** The same detection, reporting each step to `onProgress`. */
export async function detectImportKindStreaming(
  source: { sheet_text?: string; attachment?: Attachment },
  onProgress: (progress: DetectProgress) => void,
): Promise<DetectResult> {
  const events = streamRequest<DetectProgress>('/imports/detect/stream', {
    body: JSON.stringify(source),
  })
  for await (const event of events) {
    onProgress(event)
    if (event.phase === 'done') return event.result
    if (event.phase === 'error') throw new ApiError(event.status, event.detail)
  }
  throw new ApiError(422, 'Detection ended without a result.')
}

// A spreadsheet is flattened in the browser and sent as text; a PDF or photo has
// to go up as bytes so the server can extract (and OCR) it.
//
// `reader: 'llm'` skips the plain-code form parser and asks the model — what the
// "read with AI instead" retry sends when a parse came back looking wrong.
export type ReadSource = {
  sheet_text?: string
  attachment?: Attachment
  reader?: 'auto' | 'llm'
}

export function readHandoverMinutes(source: ReadSource) {
  return request<ReadResult>('/imports/handover/read', {
    method: 'POST',
    body: JSON.stringify(source),
  })
}

/** The same read, reporting each step to `onProgress` as it happens.
 *
 * Resolves with the finished reading. Throws `ApiError` for a request that never
 * opened and a plain `Error` carrying the server's message for one that failed
 * mid-stream — by then the status code is spent, so the failure arrives as an
 * event (see `streamRequest`). */
export async function readHandoverMinutesStreaming(
  source: ReadSource,
  onProgress: (progress: ReadProgress) => void,
): Promise<ReadResult> {
  const events = streamRequest<ReadProgress>('/imports/handover/read/stream', {
    body: JSON.stringify(source),
  })
  for await (const event of events) {
    onProgress(event)
    if (event.phase === 'done') return event.result
    if (event.phase === 'error') throw new ApiError(event.status, event.detail)
  }
  throw new ApiError(503, 'The read ended without a result.')
}

/** Ask the model server to load the model now, before anyone needs it.
 *
 * Ollama unloads after ten idle minutes and llama3.1:8b takes ~44s to load, which
 * the first import of the day used to pay in full mid-read. Called when the import
 * dialog opens so the load overlaps choosing a file. Deliberately swallows its own
 * failure: a cold model is a slow import, not a broken one. */
export function warmLlm() {
  return request<{ warm: boolean }>('/imports/llm/warm', { method: 'POST' }).catch(
    () => ({ warm: false }),
  )
}

export function planHandoverImport(
  parsed: ParsedMinutes,
  sourceFile?: string | null,
  itIndex?: number | null,
) {
  return request<HandoverPlan>('/imports/handover/plan', {
    method: 'POST',
    body: JSON.stringify({ parsed, source_file: sourceFile, it_index: itIndex }),
  })
}

export type UserDecision = {
  code: string
  action: 'create' | 'update' | 'reuse'
  name?: string | null
  team?: string | null
}

// `from_user_id` / `to_user_id` are the authoritative pair — the only thing that
// can describe a record with three parties, where naming "the flow" no longer says
// who is at each end. The server re-derives the flow from them.
export type ItemDecision = {
  row: number
  serial: string
  flow: Flow | 'skip'
  from_user_id?: string | null
  to_user_id?: string | null
  handover_id?: string
  handover_date?: string | null
  reason?: string | null
  create_device?: boolean
  device_fields?: Record<string, string | null>
}

export function applyHandoverImport(body: {
  source_file?: string | null
  handover_date?: string | null
  party_codes: (string | null)[]
  it_code?: string | null
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
