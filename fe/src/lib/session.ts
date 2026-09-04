// A per-browser-session id, kept in sessionStorage: stable for the lifetime of the
// tab session, gone when the tab closes. There's no login yet — this scopes
// client-side state (e.g. the Ask AI chat history) to a session, and is the
// natural key to map onto a real user account once authentication exists.
import { newId } from "./id";

const SID_KEY = "itledger.sid";

export function getSessionId(): string {
  try {
    let sid = sessionStorage.getItem(SID_KEY);
    if (!sid) {
      // newId(), not crypto.randomUUID(): the latter is undefined on this app's
      // plain-http origin, which used to send every session down the "ephemeral"
      // path below. The catch now only covers sessionStorage being blocked.
      sid = newId();
      sessionStorage.setItem(SID_KEY, sid);
    }
    return sid;
  } catch {
    return "ephemeral";
  }
}
