// Shared Ant <Table> scroll config.
//   x: horizontal scroll for wide tables (columns never squash).
//   y: cap the body height so the HEADER stays pinned while the rows scroll
//      under it — instead of the whole table (header included) scrolling with
//      the page. `max(...)` keeps a usable minimum on short viewports.
export const TABLE_SCROLL = {
  x: "max-content" as const,
  y: "max(240px, calc(100vh - 340px))",
};
