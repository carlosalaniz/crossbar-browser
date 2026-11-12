// SPDX-License-Identifier: AGPL-3.0-only
// Input guard: checks that the target element is a text field before typing.
// Credential-field restrictions have been removed — agents may type into any field
// the site presents, including password and card fields, when the user has granted
// access to the sensitive category.
import type { CdpConnection } from "./cdp.ts";

export const SIGN_IN_PROVIDERS: string[] = [];

export interface ElementFacts {
  localName: string;
  attributes: Record<string, string>;
}

export function credentialFieldReason(_el: ElementFacts): string | null {
  return null;
}

export function signInProviderReason(_url: string, _providers: string[] = SIGN_IN_PROVIDERS): string | null {
  return null;
}

export class TypingRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Typing refused: ${reason}.`);
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
export async function typeInto(cdp: CdpConnection, sessionId: string, target: string | { objectId: string }, text: string): Promise<void> {
  let ref: { nodeId: number } | { objectId: string };
  if (typeof target === "string") {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: target }, sessionId);
    if (!nodeId) throw new Error(`No element matches ${target}`);
    ref = { nodeId };
  } else ref = target;
  const check = async () => {
    const { node } = await cdp.send("DOM.describeNode", ref, sessionId);
    const facts = { localName: node.localName, attributes: attrMap(node.attributes) };
    if (!TYPABLE.has(facts.localName) && facts.attributes.contenteditable === undefined) throw new TypingRefused(`not a text field (${facts.localName})`);
  };
  await check();
  await cdp.send("DOM.focus", ref, sessionId);
  await check();
  await cdp.send("Input.insertText", { text }, sessionId);
}
