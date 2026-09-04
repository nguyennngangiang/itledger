import dayjs from "dayjs";

import type { DeviceStatus, User } from "../types";
import type { Key } from "../i18n/catalog";
import type { Vars } from "../i18n/useT";
import { GHOST_USER_CODE } from "../types";

/**
 * Today as "YYYY-MM-DD" in local time.
 *
 * Deliberately not `new Date().toISOString()`: that is UTC, which in Vietnam
 * stamps *yesterday* for anything logged before 07:00.
 */
export function todayIsoDate(): string {
  return dayjs().format("YYYY-MM-DD");
}

/** Statuses that mean IT is physically holding the machine. */
export const IT_HELD_STATUSES: DeviceStatus[] = ["maintaining", "on_del"];
export const isItHeld = (s: DeviceStatus | null | undefined) =>
  s === "maintaining" || s === "on_del";

/**
 * The owner→status rule: a device parked on the ghost IT-STORE account is
 * `in_stock`, one held by a person is `active`.
 *
 * `maintaining` and `on_del` survive only while the device sits with IT-STORE —
 * those statuses mean IT has the machine, so nobody else can be holding it.
 * Hand it to a person and it is in use again, i.e. `active`.
 */
export function deriveStatus(
  userId: string | null | undefined,
  current: DeviceStatus | null | undefined,
): DeviceStatus {
  const atTheStore = !userId || userId === GHOST_USER_CODE;
  if (!atTheStore) return "active";
  return isItHeld(current) ? current! : "in_stock";
}

/**
 * The same rule read the other way: choosing `maintaining` or `on_del` moves the
 * device to IT-STORE, because IT is the one holding it. Enforced server-side too
 * (be/repositories/device.py) — this only keeps the form honest as you type.
 */
export function ownerForStatus(
  status: DeviceStatus | null | undefined,
  userId: string,
): string {
  return isItHeld(status) ? GHOST_USER_CODE : userId;
}

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

/**
 * Label for an owner/employee picker.
 *
 * Code first, on purpose: the team identifies people by employee code, and
 * antd filters these Selects on the label — a name-only label meant typing
 * "VPHN126" matched nothing. Shared so the device and handover pickers agree.
 */
export function ownerOptionLabel(
  u: User,
  t: (key: Key, vars?: Vars) => string,
): string {
  if (u.employee_code === GHOST_USER_CODE) {
    return t("owner.storeOption", { code: GHOST_USER_CODE });
  }
  const name = u.name?.trim() || u.employee_code;
  const team = u.team?.trim();
  return team
    ? t("owner.option", { code: u.employee_code, name, team })
    : `${u.employee_code} — ${name}`;
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
 *
 * NOT translated, deliberately — two of the three outputs are not display text:
 *  * `team` falls back to `"—"`, which `MaintenanceScreen` and `MaintenanceModal`
 *    compare against (`team !== "—"`) to decide whether a team is known;
 *  * for the ghost it falls back to `"IT"`, a real team name that
 *    `MaintenanceModal.handleDeviceChange` copies into the form and POSTs.
 * Translating either changes behaviour or writes foreign text to the database.
 * Registered in i18n/exclusions.ts. Callers that want the ghost named for a
 * human use `t("owner.store")` themselves.
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
