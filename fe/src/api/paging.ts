// Shared shapes/helpers for the server-side paginated list endpoints.

export type Paged<T> = { rows: T[]; total: number };

export type PageParams = {
  limit: number;
  offset: number;
  orderBy?: string;
  order?: "asc" | "desc";
  deleted?: boolean;
  q?: string;
  status?: string; // device lifecycle status, or employee active/retired
  noTeam?: boolean; // employees only — the ones with no department recorded
};

export function pageQuery(p: PageParams): string {
  const s = new URLSearchParams();
  s.set("limit", String(p.limit));
  s.set("offset", String(p.offset));
  if (p.orderBy) s.set("order_by", p.orderBy);
  if (p.order) s.set("order", p.order);
  if (p.deleted) s.set("deleted", "true");
  if (p.q) s.set("q", p.q);
  if (p.status) s.set("status", p.status);
  if (p.noTeam) s.set("no_team", "true");
  return s.toString();
}
