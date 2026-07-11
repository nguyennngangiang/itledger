// Shared shapes/helpers for the server-side paginated list endpoints.

export type Paged<T> = { rows: T[]; total: number };

export type PageParams = {
  limit: number;
  offset: number;
  orderBy?: string;
  order?: "asc" | "desc";
  deleted?: boolean;
  q?: string;
  status?: string; // devices only
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
  return s.toString();
}
