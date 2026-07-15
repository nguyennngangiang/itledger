// Shared Ant <Table> scroll config.
//   x: horizontal scroll for wide tables (columns never squash).
//   y: only needs to be truthy — it switches Ant into split header/body mode so
//      the HEADER stays pinned while the rows scroll under it. The ACTUAL body
//      height is driven by the flex layout in App.css (`.app-content--flex` →
//      `.table-wrap .ant-table-body`), which overrides this inline value so the
//      pagination footer is always reserved and visible. Kept small on purpose.
export const TABLE_SCROLL = {
  x: "max-content" as const,
  y: 120,
};
