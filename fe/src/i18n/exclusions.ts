// Strings that look like UI copy but must NEVER be translated.
//
// Every entry here is quoted text that some piece of code compares against, or
// that gets written to the database as a value. Translating one does not make the
// app look different — it makes it behave differently, or corrupts data. They are
// listed in one place so a future translation sweep has something to check against
// rather than relying on whoever is reading the file to notice.
//
// `scripts/check-i18n.mjs` fails if any of these turns up as a catalog value.

export const DO_NOT_TRANSLATE = {
  /** `HandoverModal.looksLikeReturn()` matches the chosen reason against these to
   * decide whether the device goes back to the IT-STORE ghost and into stock.
   * Reasons are also free text saved verbatim on the handover row. */
  handoverReasons: [
    "Return to IT",
    "New hire",
    "Resignation",
    "Team transfer",
    "Device replacement",
    "Temporary loan",
    "Upgrade",
  ],

  /** `MaintenanceModal` PARTS / RESULT_OPTS — merged with live values from the API
   * by `mergeOptions()` and POSTed as the stored `part` / `result`. A translated
   * option writes a foreign-language value into the maintenance table. */
  maintenanceOptions: "see PARTS / RESULT_OPTS in Modal/MaintenanceModal.tsx",

  /** `CreateDeviceModal` FALLBACK_OPTS — same story for device specs. */
  deviceSpecOptions: "see FALLBACK_OPTS in Modal/CreateDeviceModal.tsx",

  /** Spreadsheet column matching, diacritic-folded. Not shown to anyone. */
  headerAliases:
    "see HEADER_ALIASES in Modal/ImportDevicesModal.tsx and ImportMaintenanceModal.tsx",

  /** Column headings in the exported workbook — `COLUMNS` in lib/exportDevices.ts.
   *
   * They stay English even with the shuffle on, for two reasons: the file LEAVES
   * the app (a colleague opening a sheet with Arabic headings is a real problem,
   * not a joke), and HEADER_ALIASES matches on these names, so export-then-
   * reimport only round-trips while they are unchanged.
   *
   * Enforced structurally rather than by banning the strings: "Serial Number" and
   * "Buy Date" are ALSO legitimate on-screen table headings, which should shuffle.
   * The invariant is about the module, not the words — so check-i18n.mjs asserts
   * that exportDevices.ts never imports or calls the translation layer. */
  exportColumns: "structural — see the exportDevices check in check-i18n.mjs",

  /** The em dash is a SENTINEL, not decoration: `format.ts` returns it for an
   * unknown team and `MaintenanceScreen` / `MaintenanceModal` test `team !== "—"`.
   * Translating it would silently turn "no team" into a real-looking team. */
  sentinel: "—",
} as const;
