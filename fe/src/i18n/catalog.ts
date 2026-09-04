// Every user-visible string in the app, keyed. This file IS the default language.
//
// The app had no i18n at all and was half English, half Vietnamese — the CRUD
// screens in one, the whole import/notifications subsystem in the other. English
// is now the single default; the Vietnamese copy moves into `scramble.ts` as one
// of the languages the shuffle can pick.
//
// Keys are `area.thing`. Where a count changes the wording, the base key holds
// the plural and a `.one` sibling overrides it. Interpolation is `{name}` — see
// `format()` in useT.ts.
//
// NOT everything with quotes around it belongs here. Several things must stay
// hardcoded because code compares against them or writes them to the database:
// the maintenance/handover option lists, the spreadsheet header aliases, and the
// "—" sentinel. They are listed in ./exclusions.ts and enforced by
// scripts/check-i18n.mjs.

export const EN = {
  // ---------------------------------------------------------------- app chrome
  "app.name": "IT Ledger",

  "nav.device": "Devices",
  "nav.maintenance": "Maintenance",
  "nav.handover": "Handover",
  "nav.employee": "Employees",

  "page.dashboard.title": "Dashboard",
  "page.dashboard.subtitle": "Fleet overview — device mix and lifecycle status",
  "page.device.title": "Devices",
  "page.device.subtitle": "Company hardware, owners and status",
  "page.maintenance.title": "Maintenance",
  "page.maintenance.subtitle": "Repair and service history per device",
  "page.handover.title": "Handover",
  "page.handover.subtitle": "Who received which device, and when",
  "page.employee.title": "Employees",
  "page.employee.subtitle": "People, their codes and departments",
  "page.notifications.title": "Notifications",
  "page.notifications.subtitle":
    "Disagreements found while importing handover records — waiting on a decision",

  // ------------------------------------------------------------- header controls
  "header.brandTitle": "Dashboard — fleet overview",
  "header.add": "Add",
  "header.import": "Import",
  "header.importTitle": "Pick a file — the kind is detected for you",
  "header.importKindAria": "Choose which kind of file to import",
  "header.bellTitle": "Work left over from imports",
  "header.bell.none": "Notifications — nothing to do",
  "header.bell.some": "Notifications — {n} to deal with",
  "header.scramble.on": "Shuffle the languages",
  "header.scramble.off": "Back to English",

  "quickAdd.device": "Device",
  "quickAdd.maintenance": "Maintenance",
  "quickAdd.handover": "Handover",
  "quickAdd.employee": "Employee",

  "importKind.device_list": "Devices",
  "importKind.maintenance_list": "Maintenance",
  "importKind.handover_minutes": "Handover",

  "common.loading": "Loading…",
  /** Stands in for a column the ledger has nothing in. Not the "—" sentinel:
   * that one is a compared-against value, see exclusions.ts. */
  "common.empty": "empty",

  // -------------------------------------------------------------- import issues
  "issue.kind.user_created": "New person",
  "issue.kind.user_code_mismatch": "Code may be a typo",
  "issue.kind.user_field_conflict": "Person's details disagree",
  "issue.kind.device_created_incomplete": "Device details missing",
  "issue.kind.device_field_conflict": "Device specs disagree",
  "issue.kind.device_owner_mismatch": "Device holder disagrees",
  "issue.kind.handover_duplicate": "Possible duplicate handover",
  "issue.kind.flow_ambiguous": "Direction unclear",

  "field.name": "Name",
  "field.team": "Department",
  "field.status": "Status",
  "field.type": "Type",
  "field.brand": "Brand",
  "field.cpu": "CPU",
  "field.ram": "RAM",
  "field.storage": "Storage",
  "field.serial_number": "Serial",
  "field.barcode": "Barcode",
  "field.buy_date": "Buy date",
  "field.os": "Operating system",
  "field.msoffice": "MS Office",

  "issue.desc.user_created": "{code} was not in the ledger — created from the record.",
  "issue.desc.user_code_mismatch":
    "\"{name}\" already exists under {codes} — the record says {code}, only a couple of characters apart, so one may be a typo.",
  "issue.desc.user_field_conflict": "Details disagree: {diffs}",
  "issue.desc.user_field_conflict.noCode": "No employee code could be read.",
  "issue.desc.device_created_incomplete": "New device — still missing {missing}.",
  "issue.desc.device_field_conflict": "Specs disagree: {diffs}",
  "issue.desc.device_field_conflict.plain":
    "The device's stored specs disagree with the record.",
  "issue.desc.handover_duplicate":
    "A handover already exists for this device between exactly these two people (dated {existing}) — the record is dated {proposed}.",
  "issue.desc.flow_ambiguous": "The direction of this handover could not be worked out.",

  // ------------------------------------------------------- notifications screen
  "notif.filter.open": "To deal with",
  "notif.filter.resolved": "Handled",
  "notif.filter.dismissed": "Waved through",
  "notif.count.none": "Nothing left to deal with",
  // Base key carries the plural; a ".one" sibling overrides it when n === 1.
  "notif.count": "{n} things to deal with from importing records",
  "notif.count.one": "1 thing to deal with from importing records",
  "notif.log": "{n} entries in the log",
  "notif.log.one": "1 entry in the log",
  "notif.col.kind": "Job",
  "notif.col.item": "Concerns",
  "notif.col.detail": "Detail",
  "notif.col.source": "From file",
  "notif.item.unreadable": "could not be read",
  "notif.action.pickCode": "Choose the code",
  "notif.action.complete": "Fill in",
  "notif.action.pickValues": "Choose values",
  "notif.action.dismiss": "Skip",
  "notif.action.reopen": "Reopen",
  "notif.action.refresh": "Refresh",
  "notif.empty.open": "Nothing here — importing a record brings its disagreements in.",
  "notif.empty.log": "Nothing here yet.",
  "notif.toast.resolved": "Handled",
  "notif.toast.dismissed": "Skipped",
  "notif.err.load": "Could not load the list.",
  "notif.err.update": "Could not update.",
  "notif.err.reopen": "Could not reopen.",
  "notif.err.write": "Could not save.",
  "notif.err.gone": "{code} is no longer in the ledger — skip this one.",
  "notif.err.deviceLoad": "Could not load the device.",
  "notif.resolution.kept": "Kept the stored values.",
  "notif.resolution.samePerson": "Two different people — both codes kept.",
  "notif.resolution.useCode": "Use code {code}.",

  // ------------------------------------------------------------ conflict dialog
  "conflict.keep": "Keep {value}",
  "conflict.take": "Take {value} from the record",
  "conflict.manual": "Type it",
  "conflict.none": "Nothing to choose between for this one.",
  "conflict.teamInUse": "Department already in use:",
  "conflict.pickTeam": "Pick a department",
  "conflict.specNote":
    "The record's specs differ from the stored ones. Pick the right value for each row.",
  "conflict.apply": "Apply",
  "conflict.cancel": "Cancel",
  "conflict.code.title": "Employee code may be a typo",
  "conflict.code.message": "\"{name}\" already exists under a very similar code.",
  "conflict.code.description":
    "Pick the code to use. The two records are never merged automatically — devices and handover history both point at a code.",
  "conflict.code.keep": "Different people — keep the code from the record: {code}",
  "conflict.code.use": "Same person — use the existing code: {code}",
  "conflict.code.choose": "Choose",

  // -------------------------------------------------------- handover import wizard
  "hi.title": "Import a handover record",
  "hi.step.read": "Read the record",
  "hi.step.reconcile": "Reconcile",
  "hi.step.write": "Write",
  "hi.busy.read": "Reading the record…",
  "hi.busy.reconcile": "Comparing against what is already stored…",
  "hi.busy.write": "Writing to the system…",
  // The read step's phases. Every one of these is a real step the server reported,
  // not a stage in an animation — see be/routers/imports.py `_read_events`.
  "hi.read.extracting": "Reading the file",
  "hi.read.scanning": "Finding the handover table",
  "hi.read.loadingModel": "Loading the AI model",
  "hi.read.loadingHint": "first use in a while — {seconds}s",
  "hi.read.reading": "Reading the rows",
  "hi.read.rows": "{read} of {total} rows",
  "hi.read.rowsUnknown": "{read} rows so far",
  "hi.read.rowsFound": "{total} rows",
  "hi.read.verifying": "Checking every value against the file",
  // How it was read. The fast answer is the one that needs saying out loud.
  "hi.reader.sheet": "read without AI",
  "hi.reader.sheet.why":
    "The form is on the company template, so it was parsed directly — instantly, and with nothing invented.",
  "hi.reader.llm": "read by AI",
  "hi.reader.llm.why":
    "This file is not on the template (a scan, a photo, or an older form), so the model located the fields. Every value was still checked back against the file.",
  "hi.err.read": "That file could not be read.",
  "hi.err.reconcile": "Reconciling failed.",
  "hi.err.import": "Import failed.",
  "hi.pick.button": "Choose a record",
  "hi.pick.hint":
    "Excel, PDF or a photo of a handover record. An Excel record on the company template is read instantly; a scan or a photo is read by the AI. Either way the direction is worked out from the ledger's own history.",
  "hi.warn.toggle": "{n} things did not match the file — skipped",
  "hi.read.date": "Handover date:",
  "hi.party.label": "Party {letter}",
  "hi.party.detail": "Department {dept} · Position {position}",
  "hi.dir.from": "Handed over by",
  "hi.dir.to": "Received by",
  "hi.dir.pick": "Choose a party",
  "hi.cast.it": "IT",
  "hi.cast.new": "new",
  // Where a row's direction came from. The resolver's full sentence is the tooltip.
  "hi.src.recorded": "already in the ledger",
  "hi.src.note": "from the Note column",
  "hi.src.transfer": "person to person",
  "hi.src.holder": "held it before",
  "hi.src.owner": "check this one",
  "hi.src.it": "IT hands it out",
  "hi.src.unknown": "you need to choose",
  "hi.verdict.ready": "handovers ready to write",
  "hi.col.no": "No.",
  "hi.col.item": "Item",
  "hi.col.serial": "Serial",
  "hi.col.detail": "Detail",
  "hi.col.note": "Note",
  "hi.action.otherFile": "Choose another file",
  "hi.action.dropFile": "Skip this file",
  "hi.action.reconcile": "Reconcile",
  "hi.action.back": "Back",
  "hi.action.import": "Import",
  "hi.action.importN": "Write {n} handovers",
  "hi.action.importN.one": "Write 1 handover",
  "hi.action.done": "Done",
  "hi.action.redo": "Change",
  // Captions sitting on the arrow between giver and receiver — they have to stay
  // short or the middle column squeezes the two names either side of it.
  "hi.flow.return": "back to IT",
  "hi.flow.issue": "hands over",
  "hi.flow.transfer": "transfers",
  "hi.flow.flip": "Flip direction",
  "hi.flow.skip": "Skip",
  "hi.flow.unskip": "Import this row after all",
  "hi.row.skipped": "Row skipped",
  "hi.row.header": "No. {no}",
  "hi.row.toStore": "the machine goes back to the {store}, not to the person who signed",
  "hi.row.newDevice": "new device",
  "hi.owner.store": "IT store",
  "hi.stat.handovers": "handovers",
  "hi.stat.newDevices": "new devices",
  "hi.stat.newPeople": "new people",
  "hi.stat.decisions": "for you to decide",
  "hi.it.unknownSide":
    "{reason} — the IT side could not be identified, so every row is treated as a move between two people.",
  "hi.user.create": "new",
  "hi.user.update": "has changes",
  "hi.fold.show": "Show {n} rows that are fine",
  "hi.fold.hide": "Hide {n} rows that are fine",
  "hi.nothingToDecide": "Nothing needs deciding — press Import.",
  "hi.pending": "{n} undecided items will move to the Notifications screen",
  "hi.settled": "chosen",
  "hi.settled.code": "using {code}",
  "hi.issue.leftover":
    "Leave it and this moves to the Notifications screen; the stored value stays as it is.",
  "hi.toast.done":
    "Imported: {handovers} handovers · {devices} new devices · {users} new people",
  "hi.toast.doneIssues":
    "Imported: {handovers} handovers · {devices} new devices · {users} new people · {issues} to deal with",

  // ----------------------------------------------------------- import queue
  "iq.title": "Import",
  "iq.done.title": "Done",
  "iq.drop": "Drag files here, or click to choose",
  "iq.drop.auto":
    "Excel, CSV, PDF or a photo — pick several at once and each one's kind is worked out for you.",
  "iq.drop.fixed": "Importing: {kind}. You can pick several files at once.",
  "iq.tooMany": "{max} files at a time — the rest were left out.",
  "iq.status.waiting": "waiting",
  "iq.format.image": "PHOTO",
  // What a detection is doing. `extract` is the slow one — an OCR pass on a scan.
  "iq.phase.opening": "opening the file",
  "iq.phase.extract": "reading the file",
  "iq.phase.matching": "matching headings",
  "iq.phase.asking": "asking the AI",
  "iq.byAi": "The headings were ambiguous, so the AI classified this one.",
  "iq.done.count": "{n} files imported",
  "iq.done.someIssues": "{n} of them left something to decide",
  "iq.done.someSkipped": "{n} skipped",
  // Dragging a file anywhere in the window.
  "drop.title": "Drop the file to import it",
  "drop.hint": "Handover records, device lists or repair histories — we work out which.",
  "iq.unknown": "{n} files could not be identified — pick a kind for each above.",
  "iq.remove": "Remove {name}",
  "iq.cancel": "Cancel",
  "iq.start": "Start reviewing",
  "iq.start.many": "Start reviewing ({n} files)",
  "iq.detecting": "Working it out…",
  "iq.position": "File {nth}/{total} · {name}",
  "iq.outcome.skipped": "Skipped.",
  "iq.outcome.imported": "Imported.",
  "iq.err.detect": "That file could not be identified.",
  "iq.left.title": "Still to decide",
  "iq.left.body":
    "Anything the system could not settle on its own has moved to the Notifications screen (the bell in the top bar).",
  "iq.close": "Close",
  "iq.kindByYou": "Kind chosen by you.",

  // ------------------------------------------------ spreadsheet import modals
  "sheet.device.title": "Import a device list",
  "sheet.maint.title": "Import repair history",
  "sheet.choose": "Choose .xlsx / .csv",
  "sheet.device.hint":
    "Needs a serial column; the rest are matched by name (Vietnamese headings included).",
  "sheet.maint.hint":
    "Needs a device serial column; the rest are matched by name (Vietnamese headings included).",
  "sheet.device.noRows":
    "No usable rows. The file needs a serial column (\"Serial Number\", \"Serial\", \"Số serial\").",
  "sheet.maint.noRows":
    "No usable rows. The file needs a device serial column (\"Serial\", \"Số serial\", \"Thiết bị\").",
  "sheet.unreadable": "Could not read that file. Use a .xlsx, .xls or .csv export.",
  "sheet.device.ready": "{n} devices ready to import",
  "sheet.maint.ready": "{n} repair records ready to import",
  "sheet.skipped": " · {n} rows skipped (no serial)",
  "sheet.dropFile": "Skip this file",
  "sheet.cancel": "Cancel",
  "sheet.import": "Import",
  "sheet.device.done": "Imported {n} devices",
  "sheet.device.done.skipped": "Imported {n} devices · skipped {skipped} (serial already there)",
  "sheet.maint.done": "Imported {n} repair records",
  "sheet.maint.done.skipped":
    "Imported {n} repair records · skipped {skipped} (already there, or unknown serial)",
  "sheet.failed": "Import failed",
  "sheet.col.serial": "Serial",
  "sheet.col.name": "Name",
  "sheet.col.type": "Type",
  "sheet.col.brand": "Brand",
  "sheet.col.owner": "Holder",
  "sheet.col.status": "Status",
  "sheet.col.device": "Device",
  "sheet.col.date": "Date",
  "sheet.col.part": "Part",
  "sheet.col.reason": "Reason",
  "sheet.col.result": "Result",
  "sheet.col.cost": "Cost",

  // --------------------------------------- stray strings on the English screens
  "search.device": "Search devices and owners — filters as you type",
  "search.maintenance": "Search repair records — filters as you type",
  "search.handover": "Search handovers — filters as you type",
  "search.employee": "Search code, name, department, position — filters as you type",
  "handover.effect": "Once saved, {serial} will belong to {owner}, status {status}",
  "device.autoFixed": "auto-corrected from “{value}”",
  "device.undoFix": "undo",
  "employee.namePlaceholder": "e.g. Nguyễn Văn A",

  // ------------------------------------------------------------ device export
  "export.button": "Export",
  "export.title":
    "Download every device in the ledger as Excel — all fields plus the owner. Ignores the filters on screen.",
  "export.done": "Exported {n} devices",
  "export.empty": "Nothing to export in this view",
  "export.failed": "Export failed",

  // ------------------------------------------------------------ shared widgets
  "confirm.title": "Confirm",
  "confirm.default": "Are you sure you want to proceed?",
  "confirm.cancel": "Cancel",
  "confirm.ok": "Confirm",

  "bulk.selected": "{n} selected",
  "bulk.clear": "Clear",
  "bulk.delete": "Delete selected",
  "bulk.deleteForever": "Delete permanently",

  "trash.toActive": "Back to the active list",
  "trash.toTrash": "Open the trash",
  "trash.trash": "Trash",
  "trash.empty": "Trash is empty",

  "feed.title": "Fleet pulse — latest movements",
  "feed.count": "most recent",
  "feed.empty": "No activity yet",

  "aging.title": "Aging watchlist",
  "aging.count": "{n} devices",
  "aging.empty": "No purchase-date data yet",
  "aging.years": "{n} yrs",

  "trash.back": "Back",

  "spend.title": "Repair spend",
  "spend.window": "6 months",
  "spend.sub": "spent this quarter · {n} repairs",
  "spend.sub.one": "spent this quarter · 1 repair",
  "spend.topPart": "Top part this period: ",
  "spend.then": ", then ",

  "detail.close": "Close",
  "detail.unknownDevice": "Unknown device",
  "detail.bought": "{serial} · bought {date}",
  "detail.empty.maintenance":
    "Select a repair to read its story — problem, fix, result, and this device's other repairs.",
  "detail.empty.handover":
    "Select a handover to trace its device's full chain of custody.",
  "journey.title": "Device journey",
  "journey.count": "{n} handovers",
  "journey.empty": "No handover history for this device yet.",
  "journey.note":
    "This chain is the device's story over cells — every keeper, when, and why, straight from the handover ledger.",
  "journey.registered": "Registered to stock",

  "story.problem": "Problem",
  "story.problem.empty": "No problem description recorded.",
  "story.solution": "Solution",
  "story.solution.empty": "No solution recorded yet.",
  "story.result": "Result",
  "story.result.empty": "No result recorded yet.",
  "story.cost": "Cost",
  "story.part": "Part",
  "story.history": "History on this device",
  "story.historyCount": "{n} repairs · {cost}",
  "story.historyCount.one": "1 repair · {cost}",
  "story.thisRecord": "This record · {part}",
  "story.repair": "Repair",
  "story.sub": "{serial} · {owner}",

  // -------------------------------------------------------------- table screens
  // Shared by all four screens: the same row actions and the same outcomes.
  "row.toast.trashed": "Moved to trash",
  "row.toast.deleted": "Permanently deleted",
  "row.toast.restored": "Restored",
  "row.toast.failed": "Failed: {error}",
  "row.bulk.trashed": "{n} moved to trash",
  "row.bulk.deleted": "{n} permanently deleted",
  "row.action.edit": "Edit {label}",
  "row.action.trash": "Move {label} to trash",
  "row.action.deleteForever": "Permanently delete {label}",
  "row.action.specs": "Specifications for {label}",
  "row.action.details": "Details of the {label}",
  "row.action.restore": "Restore",
  "panel.trash": "Trash",
  "panel.total": "{n} total",

  "device.panel": "Device inventory",
  "device.col.device": "Device",
  "device.col.owner": "Owner",
  "device.col.serial": "Serial Number",
  "device.col.status": "Status",
  "device.col.buyDate": "Buy Date",
  "device.chip.all": "All",
  "device.refresh": "Refresh",
  "device.add": "Add Device",
  "device.toast.restored": "Device restored",
  "device.toast.deleted": "Device permanently deleted",
  "device.confirm.delete": "Permanently delete “{name}”? This cannot be undone.",
  "device.confirm.trash": "Move “{name}” to trash?",
  "device.confirm.bulkDelete":
    "Permanently delete {n} selected devices? This cannot be undone.",
  "device.confirm.bulkTrash": "Move {n} selected devices to trash?",

  "maint.panel": "Maintenance records",
  "maint.col.date": "Date",
  "maint.col.device": "Device",
  "maint.col.owner": "Owner",
  "maint.col.team": "Team",
  "maint.col.part": "Part",
  "maint.detail.title": "Repair details",
  "maint.detail.problem": "Problem",
  "maint.detail.solution": "Solution",
  "maint.detail.result": "Result",
  "maint.detail.cost": "Cost (VND)",
  "maint.detail.remarks": "Remarks",
  "maint.confirm.delete":
    "Permanently delete this maintenance record? This cannot be undone.",
  "maint.confirm.trash": "Move this maintenance record to trash?",
  "maint.confirm.bulkDelete":
    "Permanently delete {n} selected records? This cannot be undone.",
  "maint.confirm.bulkTrash": "Move {n} selected records to trash?",
  "maint.add": "Add Maintenance",

  "handover.panel": "Handover history",
  "handover.col.date": "Date",
  "handover.col.device": "Device",
  "handover.col.transfer": "Transfer",
  "handover.col.reason": "Reason",
  "handover.confirm.delete":
    "Permanently delete this handover record? This cannot be undone.",
  "handover.confirm.trash": "Move this handover record to trash?",
  "handover.confirm.bulkDelete":
    "Permanently delete {n} selected handovers? This cannot be undone.",
  "handover.confirm.bulkTrash": "Move {n} selected handovers to trash?",
  "handover.add": "Add Handover",

  "employee.panel": "Employees",
  "employee.col.code": "Employee Code",
  "employee.col.name": "Name",
  "employee.col.team": "Department",
  "employee.col.status": "Status",
  "employee.status.active": "Active",
  "employee.status.retired": "Retired",
  "employee.filter.all": "Everyone",
  "employee.filter.noTeam": "No department",
  "employee.toast.restored": "Employee restored",
  "employee.toast.deleted": "Employee permanently deleted",
  "employee.confirm.delete": "Permanently delete “{name}”? This cannot be undone.",
  "employee.confirm.trash": "Move “{name}” to trash?",
  "employee.confirm.bulkDelete":
    "Permanently delete {n} selected employees? This cannot be undone.",
  "employee.confirm.bulkTrash": "Move {n} selected employees to trash?",
  "employee.add": "Add Employee",
  // ----------------------------------------------------------------- dashboard
  "dash.live": "Ledger current — last entry: {date}",
  "dash.totalDevices": "Total Devices",
  "dash.byBrand": "Devices by brand",
  "dash.byCpu": "Devices by CPU",
  "dash.byOs": "Devices by OS",
  "dash.byStatus": "Devices by status",
  "dash.unit.brands": "brands",
  "dash.unit.types": "types",
  "dash.total": "{n} total",
  "dash.noData": "No data yet",
  "dash.unknown": "Unknown",
  "dash.serviced": "{device} serviced",
  "dash.servicedPart": "{device} serviced — {part}",
  "dash.handed": "{device} handed to {name} ({team})",
  "dash.handedReason": "{device} handed to {name} ({team}) — {reason}",
  "dash.added": "{device} added to the ledger",

  // ----------------------------------------------------------------- form modals
  "form.cancel": "Cancel",
  "form.save": "Save changes",
  "form.submit": "Submit",
  "form.optional": "Optional",
  "form.required": "{field} is required.",

  "deviceForm.create": "Create Device",
  "deviceForm.edit": "Edit Device",
  "deviceForm.serial": "Serial Number",
  "deviceForm.serialPlaceholder": "SN123456789",
  "deviceForm.name": "Device Name",
  "deviceForm.namePlaceholder": "Dell Latitude 5420",
  "deviceForm.owner": "Owner",
  "deviceForm.status": "Status",
  "deviceForm.datePlaceholder": "DD-MM-YYYY",
  "deviceForm.failed": "Failed to save device",
  "deviceForm.itHeld":
    "{status} means IT is holding the machine, so the owner is IT Store. Hand it back to a person when the work is done.",

  "maintForm.create": "Log Maintenance",
  "maintForm.edit": "Edit Maintenance",
  "maintForm.device": "Device",
  "maintForm.devicePlaceholder": "Select a device",
  "maintForm.deviceLoading": "Loading devices…",
  "maintForm.team": "Team",
  "maintForm.teamPlaceholder": "Follows the device owner's team",
  "maintForm.part": "Part",
  "maintForm.cost": "Cost (VND)",
  "maintForm.date": "Date",
  "maintForm.result": "Result",
  "maintForm.resultPlaceholder": "Fixed",
  "maintForm.problem": "Problem description",
  "maintForm.solution": "Solution",
  "maintForm.remark": "Remark",
  "maintForm.loadFailed": "Failed to load form data",
  "maintForm.failed": "Failed to submit maintenance",

  "handoverForm.create": "Record Handover",
  "handoverForm.edit": "Edit Handover",
  "handoverForm.device": "Device",
  "handoverForm.from": "From",
  "handoverForm.to": "To",
  "handoverForm.date": "Date",
  "handoverForm.reason": "Reason",
  "handoverForm.pickDevice": "Select a device",
  "handoverForm.pickEmployee": "Select an employee",
  "handoverForm.loadingDevices": "Loading devices…",
  "handoverForm.loadingEmployees": "Loading employees…",
  "handoverForm.devicesFailed": "Could not load devices",
  "handoverForm.employeesFailed": "Could not load employees",
  "handoverForm.samePerson": "From and to employee must be different",
  "handoverForm.ownerNotUpdated":
    "Handover saved, but the device's owner could not be updated. Change it on the Devices screen.",
  "handoverForm.loadFailed": "Failed to load form data",
  "handoverForm.failed": "Failed to submit handover",

  "employeeForm.create": "Add Employee",
  "employeeForm.edit": "Edit Employee",
  "employeeForm.code": "Employee Code",
  "employeeForm.codePlaceholder": "VPHN123",
  "employeeForm.name": "Full Name",
  "employeeForm.team": "Department",
  "employeeForm.teamPlaceholder": "Start typing — e.g. IT, FMD, Accounting",
  "employeeForm.status": "Status",
  "employeeForm.statusHint":
    "Retired keeps the person in the ledger — their handover history still reads, and any device they never returned stays visible. Use the trash only for a row entered by mistake.",
  "employeeForm.failed": "Failed to save employee",

  "paging.range": "{from}–{to} of {n}",
  "owner.store": "IT Store",
  "owner.storeOption": "{code} — IT Store (in stock)",
  "owner.option": "{code} — {name} ({team})",
} as const;

export type Key = keyof typeof EN;

/** Runtime guard for keys built by concatenation (`page.${page}.title`). */
export const isKey = (k: string): k is Key => k in EN;
