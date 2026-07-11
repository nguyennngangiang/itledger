import type { User } from "../types";
import { GHOST_USER_CODE } from "../types";

/** Format an ISO date string ("2024-05-26") as "DD-MM-YYYY". Falls back to "—". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}-${m}-${y}`;
}

export type UserMap = Record<string, User>;

/** Build a { employee_code -> User } lookup from a user list. */
export function toUserMap(users: User[]): UserMap {
  return Object.fromEntries(users.map((u) => [u.employee_code, u]));
}

export type Owner = {
  code: string | null;
  name: string;
  team: string;
  isGhost: boolean;
};

/**
 * Resolve a device/record owner into display parts.
 * Ownerless (null) is treated the same as the ghost IT-store account.
 */
export function resolveOwner(
  userId: string | null | undefined,
  users: UserMap,
): Owner {
  const code = userId ?? GHOST_USER_CODE;
  const u = users[code];
  const isGhost = code === GHOST_USER_CODE;
  return {
    code: userId ?? null,
    name: u?.name?.trim() || (isGhost ? "IT Store" : code),
    team: u?.team?.trim() || (isGhost ? "IT" : "—"),
    isGhost,
  };
}
