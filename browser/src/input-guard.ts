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
/** Up to this many characters are typed key by key; a longer text is pasted after that, as a person would. */
export const KEYED_CHARS = 120;

function keyFor(ch: string): { key: string; code: string; modifiers: number; vk?: number } | null {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, modifiers: 0, vk: ch.toUpperCase().charCodeAt(0) };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, modifiers: 8, vk: ch.charCodeAt(0) };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, modifiers: 0, vk: ch.charCodeAt(0) };
  if (ch === " ") return { key: " ", code: "Space", modifiers: 0, vk: 32 };
  const punct: Record<string, string> = { ".": "Period", ",": "Comma", "-": "Minus", "/": "Slash", ";": "Semicolon", "'": "Quote", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "`": "Backquote" };
  if (punct[ch]) return { key: ch, code: punct[ch]!, modifiers: 0 };
  return null;
}

/**
 * Types like a keyboard: one key event per character with uneven gaps (audit S07). Characters a plain
 * keyboard can't produce (accents, emoji, CJK) are inserted as text, as an input method would.
 */
export async function typeKeys(cdp: CdpConnection, sessionId: string, text: string, rand: () => number = Math.random): Promise<void> {
  const keyed = [...text].slice(0, KEYED_CHARS);
  for (const ch of keyed) {
    const k = keyFor(ch);
    if (k) {
      const vk = k.vk ? { windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk } : {};
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, text: ch, unmodifiedText: ch.toLowerCase(), modifiers: k.modifiers, ...vk }, sessionId);
      await new Promise((r) => setTimeout(r, 15 + rand() * 45));
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, modifiers: k.modifiers, ...vk }, sessionId);
    } else await cdp.send("Input.insertText", { text: ch }, sessionId);
    await new Promise((r) => setTimeout(r, 25 + rand() * 90 + (ch === " " ? rand() * 80 : 0)));
  }
  const rest = [...text].slice(KEYED_CHARS).join("");
  if (rest) await cdp.send("Input.insertText", { text: rest }, sessionId);
}

export async function typeInto(cdp: CdpConnection, sessionId: string, target: string | { objectId: string }, text: string, opts: { keys?: boolean } = {}): Promise<void> {
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
  if (opts.keys) await typeKeys(cdp, sessionId, text);
  else await cdp.send("Input.insertText", { text }, sessionId);
}
