// SPDX-License-Identifier: AGPL-3.0-only
// Credential-field guard (Access Model L3; AGENTS.md "never" 7).
// Agents may never type into password, one-time-code or card fields, or on sign-in providers.
// Checked by element type, so it doesn't depend on the agent behaving.
import type { CdpConnection } from "./cdp.ts";

export const SIGN_IN_PROVIDERS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
  "idmsa.apple.com",
];

const CREDENTIAL_AUTOCOMPLETE = new Set(["one-time-code", "current-password", "new-password"]);

export interface ElementFacts {
  localName: string;
  attributes: Record<string, string>;
}

/** Why typing into this element is refused, or null if it's allowed. */
export function credentialFieldReason(el: ElementFacts): string | null {
  const name = el.localName.toLowerCase();
  const attrs = Object.fromEntries(Object.entries(el.attributes).map(([k, v]) => [k.toLowerCase(), v]));
  if (name === "input" && (attrs.type ?? "").trim().toLowerCase() === "password") return "password field";
  const tokens = (attrs.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (t.startsWith("cc-")) return `card field (autocomplete=${t})`;
    if (CREDENTIAL_AUTOCOMPLETE.has(t)) return `credential field (autocomplete=${t})`;
  }
  return null;
}

export function signInProviderReason(url: string, providers: string[] = SIGN_IN_PROVIDERS): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "unparseable page URL";
  }
  const hit = providers.find((p) => host === p || host.endsWith(`.${p}`));
  return hit ? `sign-in provider (${hit})` : null;
}

export class TypingRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Typing refused: ${reason}. A person has to do this through takeover.`);
    this.reason = reason;
  }
}

function attrMap(flat: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; flat && i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
  return out;
}

const TYPABLE = new Set(["input", "textarea"]);

/**
 * Types text into the element matching `selector` in the target behind `sessionId`.
 * Checks the element before focusing and again after focus, because a page can change an
 * input's type in a focus handler.
 */
export async function typeInto(cdp: CdpConnection, sessionId: string, selector: string, text: string, opts: { providers?: string[] } = {}): Promise<void> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
  const pageUrl = root.documentURL ?? "";
  const providerReason = signInProviderReason(pageUrl, opts.providers);
  if (providerReason) throw new TypingRefused(providerReason);

  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector }, sessionId);
  if (!nodeId) throw new Error(`No element matches ${selector}`);
  const check = async () => {
    const { node } = await cdp.send("DOM.describeNode", { nodeId }, sessionId);
    const facts = { localName: node.localName, attributes: attrMap(node.attributes) };
    const reason = credentialFieldReason(facts);
    if (reason) throw new TypingRefused(reason);
    if (!TYPABLE.has(facts.localName) && facts.attributes.contenteditable === undefined) throw new TypingRefused(`not a text field (${facts.localName})`);
  };
  await check();
  await cdp.send("DOM.focus", { nodeId }, sessionId);
  await check();
  await cdp.send("Input.insertText", { text }, sessionId);
}
