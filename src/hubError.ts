/**
 * What went wrong with a hub, read from the message Rust sends (src-tauri/src/hubclient.rs):
 * "hub <url>: bad token", "hub <url> is at schema N, this app is at M: …",
 * "hub <url>: refused (Origin/Host)", "hub <url>: unreachable: …". Anything else is
 * told as a failure to reach it.
 */
export type HubErrorKind = "token" | "schema" | "refused" | "unreachable";

export function classifyHubError(message: string): {
  kind: HubErrorKind;
  /** The error screen's heading. */
  heading: string;
  /** The banner's lead-in, before the message. */
  label: string;
} {
  if (/: bad token\b/.test(message)) {
    return { kind: "token", heading: "The hub refused the token.", label: "Hub refused the token" };
  }
  if (/ is at schema \d+/.test(message)) {
    return {
      kind: "schema",
      heading: "The hub runs a different Tildone build.",
      label: "Hub runs a different build",
    };
  }
  if (/: refused \(Origin\/Host\)/.test(message)) {
    return {
      kind: "refused",
      heading: "The hub refused this address.",
      label: "Hub refused the address",
    };
  }
  return { kind: "unreachable", heading: "Couldn’t reach the hub.", label: "Hub unreachable" };
}
