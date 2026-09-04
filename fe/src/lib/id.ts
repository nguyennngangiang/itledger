// Client-side id generation for new records (handover_id, maintenance_id, session id).
//
// `crypto.randomUUID()` alone is NOT usable here: it is gated to secure contexts,
// so it exists on https:// and on localhost but is *undefined* on this app's real
// origin, http://192.168.3.252:10000. Calling it there throws a TypeError before
// any fetch happens, which is why Create Handover / Create Maintenance failed on
// the LAN build while working fine in local dev.
//
// `crypto.getRandomValues()` has no such gate, so the fallback is still real
// randomness — not Math.random with a timestamp.

function uuidFromRandomValues(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/** A v4 UUID, in every browser context this app actually runs in. */
export function newId(): string {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto.getRandomValues === "function") return uuidFromRandomValues();
  }
  // No Web Crypto at all (very old browser). Collision risk is irrelevant here:
  // these ids only have to be unique within one company's ledger.
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `${rnd()}-${rnd().slice(0, 4)}-4${rnd().slice(0, 3)}-${rnd().slice(0, 4)}-${rnd()}${rnd().slice(0, 4)}`;
}
