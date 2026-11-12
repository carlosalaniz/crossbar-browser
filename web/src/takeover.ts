// SPDX-License-Identifier: AGPL-3.0-only
// Take control: the remote page as a window you use directly, phone first.
// - Tap to click (the press lasts as long as your finger), drag to scroll, pinch to zoom the view.
// - Tap a text field and the phone keyboard opens at once; the view zooms to the form and stays above the
//   keyboard. What you type reaches the page key by key as you type it; a password-manager fill arrives
//   whole, as it does on any site.
// - On desktop, mouse and keyboard go straight to the page.
// The device never changes (ADR 0015); input is ordered and bound to the tab it was aimed at (ADR 0016).
import { clientToPage, fieldAt, fitSize, keyFor, originOf, textEdit, zoomToBox, type PageBox } from "./logic.ts";

type Child = Node | string | null | undefined | false | Child[];
export interface TakeoverDeps {
  h(tag: string, attrs?: Record<string, unknown>, ...children: Child[]): HTMLElement;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  render(node: HTMLElement): void;
  onCleanup(fn: () => void): void;
}

type Kind = "text" | "password" | "otp" | "frame";
interface ViewState {
  focus: (PageBox & { kind: Kind; area: PageBox | null }) | null;
  fields: Array<PageBox & { kind: Exclude<Kind, "frame"> }>;
}
interface Claim {
  tab: string;
  origin: string;
  agent?: string | null;
}
interface InputReply {
  tab: string;
  url: string;
  view?: ViewState;
}

const TAP_SLOP = 10;
const KIND_LABEL: Record<Kind, string> = { text: "Text", password: "Password", otp: "One-time code", frame: "Sign-in box" };
const MODS = (e: KeyboardEvent | MouseEvent | WheelEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** The open take-control window's teardown, so taking control again never leaves the old one running. */
let disposeOpen: (() => void) | null = null;

export async function takeoverWindow(id: string, deps: TakeoverDeps): Promise<void> {
  disposeOpen?.();
  const disposers: Array<() => void> = [];
  disposeOpen = () => {
    for (const f of disposers.splice(0)) f();
    disposeOpen = null;
  };
  const d: TakeoverDeps = { ...deps, onCleanup: (fn) => (disposers.push(fn), deps.onCleanup(fn)) };
  const { h, api } = d;
  // Nothing from a previous window stays clickable while control is being taken.
  d.render(h("div", { class: "tk" }, h("div", { class: "tk-msg" }, "Taking control…")));
  let claim: Claim;
  try {
    claim = await api<Claim>("POST", `/api/tickets/${id}/claim`);
  } catch (e) {
    d.render(h("div", { class: "tk" }, h("div", { class: "tk-msg" }, h("p", { class: "error" }, (e as Error).message), h("a", { class: "btn", href: `#/tickets/${id}` }, "Back"))));
    return;
  }

  let current = claim.tab;
  let url = claim.origin;
  let page = { w: 1280, h: 800 };
  let fit = 1;
  let zoom = { s: 1, x: 0, y: 0 };
  let zoomTarget: PageBox | null = null;
  let fields: ViewState["fields"] = [];
  let typingKind: Kind | null = null;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const mobileSite = () => page.w <= 600;

  // ---- elements ----
  const img = h("img", { class: "tk-img", alt: "The page you're controlling", draggable: "false" }) as HTMLImageElement;
  const stage = h("div", { class: "tk-stage" }, img);
  const hint = h("div", { class: "tk-hint" }, coarse ? "Tap to click · drag to scroll · pinch to zoom" : "Click the page to control it. Mouse and keyboard go straight to it.");
  const badge = h("div", { class: "tk-badge", hidden: true });
  const view = h("div", { class: "tk-view", tabindex: "0", "aria-label": "Remote page. Click to control it." }, stage, hint, badge);
  setTimeout(() => hint.classList.add("gone"), 4000);
  const lock = h("span", { class: "tk-lock", "aria-hidden": "true" });
  const originText = h("span", { class: "tk-origin-text" });
  const status = h("span", { class: "tk-status", title: "Round trip to the browser" }, "connecting…");
  const banner = h("div", { class: "tk-banner", hidden: true });
  const err = h("p", { class: "tk-error", role: "alert" });

  // The typing bar: a real field, so the phone keyboard, autocorrect and password managers work.
  const kbd = h("input", { class: "tk-kbd", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Type into the page", enterkeyhint: "next" }) as HTMLInputElement;
  const typingLabel = h("div", { class: "tk-typing-label" });
  const fillBtn = h("button", { class: "tk-btn tk-fill", type: "button", hidden: true, onclick: () => fill() }, "🔑 Fill");
  const typingBar = h(
    "div",
    { class: "tk-typing", hidden: true },
    h("div", { class: "tk-typing-field" }, h("div", { class: "tk-typing-main" }, typingLabel, kbd), fillBtn),
    h(
      "div",
      { class: "tk-row" },
      h("button", { class: "tk-btn", type: "button", onpointerdown: (e: Event) => e.preventDefault(), onclick: () => pressKey("Tab") }, "Next field"),
      h("button", { class: "tk-btn", type: "button", onpointerdown: (e: Event) => e.preventDefault(), onclick: () => pressKey("Enter") }, "Enter"),
      h("button", { class: "tk-btn", type: "button", onclick: () => wholePage() }, "Whole page"),
    ),
  );
  const more = h(
    "div",
    { class: "tk-more", hidden: true },
    ...[["Tab", "Tab"], ["Enter", "Enter"], ["Esc", "Escape"], ["⌫", "Backspace"], ["←", "ArrowLeft"], ["→", "ArrowRight"]].map(([label, key]) => h("button", { class: "tk-btn", type: "button", onclick: () => pressKey(key!) }, label!)),
    h("button", { class: "tk-btn", type: "button", onclick: () => wholePage() }, "Whole page"),
    h("button", {
      class: "tk-btn",
      type: "button",
      onclick: async () => {
        await api("POST", `/api/tickets/${id}/not-a-wall`).catch((e) => (err.textContent = (e as Error).message));
        location.hash = "#/";
      },
    }, "Not a wall — let the agent go on"),
  );
  const footer = h(
    "footer",
    { class: "tk-actions" },
    h("button", { class: "tk-btn", type: "button", onclick: () => startTyping(null, true) }, "⌨︎ Keyboard"),
    h("button", { class: "tk-btn", type: "button", onclick: () => (more.hidden = !more.hidden) }, "More"),
  );
  const root = h(
    "div",
    { class: "tk" },
    h(
      "header",
      { class: "tk-bar" },
      h("a", { class: "tk-close", href: `#/tickets/${id}`, "aria-label": "Leave (the page stays as it is)" }, "✕"),
      // The real origin, drawn by Crossbar outside the stream, so the page can't fake it.
      h("div", { class: "tk-origin" }, lock, originText),
      h("button", { class: "tk-btn primary tk-done", type: "button", onclick: () => void done() }, "Done"),
    ),
    h("div", { class: "tk-sub" }, h("span", {}, `${claim.agent ?? "The agent"} is paused and sees nothing while you're in control.`), status),
    banner,
    view,
    err,
    typingBar,
    more,
    footer,
  );
  d.render(root);

  // ---- staying above the phone keyboard ----
  // The window takes the visible part of the screen: when the keyboard opens it shrinks, so the typing bar
  // sits right above the keyboard and the zoomed form stays in view, never under it.
  const vv = window.visualViewport;
  const fitToScreen = () => {
    if (vv) {
      root.style.height = `${vv.height}px`;
      root.style.transform = `translateY(${vv.offsetTop}px)`;
    }
    layout();
  };
  vv?.addEventListener("resize", fitToScreen);
  vv?.addEventListener("scroll", fitToScreen);
  d.onCleanup(() => {
    vv?.removeEventListener("resize", fitToScreen);
    vv?.removeEventListener("scroll", fitToScreen);
  });

  // ---- layout and zoom ----
  const applyTransform = () => {
    stage.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    const pct = Math.round(zoom.s * fit * 100);
    badge.hidden = zoom.s <= 1.01;
    badge.textContent = zoomTarget ? `Zoomed to the form · ${pct}%` : `${pct}%`;
  };
  const layout = () => {
    const r = view.getBoundingClientRect();
    const f = fitSize(page, { w: r.width, h: r.height }, coarse);
    fit = f.scale;
    img.style.width = `${f.w}px`;
    img.style.height = `${f.h}px`;
    if (zoomTarget) zoomTo(zoomTarget);
    else applyTransform();
  };
  const zoomTo = (target: PageBox) => {
    zoomTarget = target;
    const v = view.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    // Where the unzoomed image's top-left sits in the view (the translate moves it; the scale doesn't).
    const origin = { x: s.left - v.left - zoom.x, y: s.top - v.top - zoom.y };
    zoom = zoomToBox(target, { w: v.width, h: v.height }, fit, origin);
    applyTransform();
  };
  const wholePage = () => {
    zoomTarget = null;
    zoom = { s: 1, x: 0, y: 0 };
    applyTransform();
  };
  const ro = new ResizeObserver(() => layout());
  ro.observe(view);
  d.onCleanup(() => ro.disconnect());
  fitToScreen();

  // ---- stream ----
  const onUrl = (u: string) => {
    url = u;
    originText.textContent = originOf(u);
    lock.textContent = u.startsWith("https:") ? "🔒" : "⚠︎";
    const differs = originOf(u) !== originOf(claim.origin);
    banner.hidden = !differs;
    banner.textContent = differs ? `Now on ${originOf(u)}. Check it before typing a password.` : "";
  };
  onUrl(claim.origin);
  let es: EventSource | null = null;
  const startStream = () => {
    es?.close();
    es = new EventSource(`/api/live/${encodeURIComponent(current)}/stream`);
    es.onmessage = (e) => {
      const f = JSON.parse(e.data) as { f: string; w: number; h: number };
      img.src = `data:image/jpeg;base64,${f.f}`;
      if (status.textContent === "connecting…") status.textContent = "● live";
      if (f.w !== page.w || f.h !== page.h) {
        page = { w: f.w, h: f.h };
        layout();
      }
    };
    es.addEventListener("url", (e) => onUrl(JSON.parse((e as MessageEvent).data)));
  };
  startStream();
  d.onCleanup(() => es?.close());
  const refreshView = async () => {
    const r = await api<{ tab: string; view: ViewState }>("GET", `/api/tickets/${id}/view`).catch(() => null);
    if (r && r.tab === current) applyView(r.view);
  };
  void refreshView();

  // A sign-in window the page opens becomes what you're driving; follow it, and come back when it closes.
  const follow = async () => {
    const t = await api<{ takeoverTab: string | null }>("GET", `/api/tickets/${id}`).catch(() => null);
    if (t?.takeoverTab && t.takeoverTab !== current) switchTab(t.takeoverTab);
  };
  const followTimer = setInterval(follow, 1000);
  d.onCleanup(() => clearInterval(followTimer));
  const switchTab = (tab: string) => {
    current = tab;
    queue = Promise.resolve();
    fields = [];
    stopTyping();
    wholePage();
    startStream();
    void refreshView();
  };

  // ---- ordered input ----
  let queue: Promise<unknown> = Promise.resolve();
  let pressed = false;
  const send = (ev: Record<string, unknown>): Promise<InputReply | null> => {
    const aimed = current;
    const p = queue.then(async () => {
      if (aimed !== current) return null; // control moved: drop, never replay elsewhere
      const t0 = performance.now();
      try {
        const r = await api<InputReply>("POST", `/api/tickets/${id}/input`, { ...ev, tab: aimed });
        status.textContent = `● ${Math.round(performance.now() - t0)} ms`;
        err.textContent = "";
        if (r.view && r.tab === current) applyView(r.view);
        return r;
      } catch (e) {
        if ((e as Error).message === "tab_changed") void follow();
        else err.textContent = (e as Error).message;
        return null;
      }
    });
    queue = p;
    return p;
  };
  const pointAt = (e: { clientX: number; clientY: number }) => clientToPage({ x: e.clientX, y: e.clientY }, img.getBoundingClientRect(), page);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pressKey = (key: string) => {
    void send({ type: "keyDown", key, code: key, text: key === "Enter" ? "\r" : "" });
    void send({ type: "keyUp", key, code: key });
  };

  // ---- what has focus in the page ----
  const applyView = (v: ViewState) => {
    fields = v.fields;
    if (v.focus) {
      startTyping(v.focus, false);
      const target = v.focus.area ?? pad(v.focus);
      // Re-zoom only if the form moved (the page scrolled it, or a new field took focus).
      if (!zoomTarget || Math.abs(zoomTarget.x - target.x) + Math.abs(zoomTarget.y - target.y) + Math.abs(zoomTarget.w - target.w) > 6) zoomTo(target);
    } else if (typingKind) stopTyping();
  };
  const pad = (b: PageBox): PageBox => ({ x: b.x - 24, y: b.y - 48, w: b.w + 48, h: b.h + 96 });

  // ---- typing ----
  let typed = "";
  const startTyping = (f: (PageBox & { kind: Kind }) | null, openKeyboard: boolean) => {
    const kind = f?.kind ?? typingKind ?? "text";
    if (kind !== typingKind) {
      kbd.value = typed = "";
      kbd.type = kind === "password" ? "password" : "text";
      kbd.autocomplete = kind === "password" ? "current-password" : kind === "otp" ? "one-time-code" : "on";
      kbd.inputMode = kind === "otp" ? "numeric" : "text";
    }
    typingKind = kind;
    hint.classList.add("gone");
    typingLabel.textContent = `Typing into: ${KIND_LABEL[kind]} · ${hostOf(url)}`;
    fillBtn.hidden = kind !== "password" && kind !== "otp";
    typingBar.hidden = false;
    footer.hidden = true;
    more.hidden = true;
    // On phones the keyboard opens when our field gets focus; on desktop, keys go to the page directly.
    if (coarse || openKeyboard) {
      if (document.activeElement !== kbd) kbd.focus({ preventScroll: true });
    } else view.focus();
  };
  const stopTyping = () => {
    typingKind = null;
    typingBar.hidden = true;
    footer.hidden = false;
    kbd.value = typed = "";
    if (document.activeElement === kbd) kbd.blur();
  };
  const fill = () => {
    // Password managers offer their fill for a focused password field (above the keyboard on phones).
    kbd.blur();
    kbd.focus();
  };
  kbd.addEventListener("input", (e) => {
    const how = (e as InputEvent).inputType ?? "";
    const { backspaces, insert } = textEdit(typed, kbd.value);
    typed = kbd.value;
    for (let i = 0; i < backspaces; i++) pressKey("Backspace");
    if (!insert) return;
    // A fill or paste arrives whole, as it would on the site itself; typing arrives key by key.
    if (how.startsWith("insertFrom") || how === "insertReplacementText" || insert.length > 3) {
      void send({ type: "insertText", text: insert });
      return;
    }
    for (const ch of insert) {
      const k = keyFor(ch);
      if (!k) {
        void send({ type: "insertText", text: ch });
        continue;
      }
      void send({ type: "keyDown", key: k.key, code: k.code, text: ch, modifiers: k.shift ? 8 : 0 });
      void send({ type: "keyUp", key: k.key, code: k.code, modifiers: k.shift ? 8 : 0 });
    }
  });
  kbd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pressKey(e.key);
      kbd.value = typed = "";
    } else if (e.key === "Backspace" && !kbd.value) {
      // Nothing left in our field: delete in the page anyway.
      e.preventDefault();
      pressKey("Backspace");
    }
  });

  // ---- mouse and pen (desktop): straight through ----
  let lastMove = 0;
  view.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    const p = pointAt(e);
    if (!p) return;
    e.preventDefault();
    view.focus();
    view.setPointerCapture(e.pointerId);
    pressed = true;
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    void send({ type: "mouseMoved", ...p });
    void send({ type: "mousePressed", ...p, button, clickCount: Math.max(1, e.detail || 1), modifiers: MODS(e) });
  });
  view.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const now = performance.now();
    if (now - lastMove < 33) return;
    lastMove = now;
    const p = pointAt(e);
    if (p) void send({ type: "mouseMoved", ...p, buttons: pressed ? 1 : 0, modifiers: MODS(e) });
  });
  view.addEventListener("pointerup", (e) => {
    if (e.pointerType === "touch" || !pressed) return;
    pressed = false;
    const p = pointAt(e) ?? { x: 0, y: 0 };
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    void send({ type: "mouseReleased", ...p, button, clickCount: Math.max(1, e.detail || 1), modifiers: MODS(e) });
  });
  view.addEventListener("contextmenu", (e) => e.preventDefault());
  view.addEventListener(
    "wheel",
    (e) => {
      const p = pointAt(e);
      if (!p) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? page.h : 1;
      void send({ type: "mouseWheel", ...p, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: MODS(e) });
    },
    { passive: false },
  );
  view.addEventListener("keydown", (e) => {
    if (e.target !== view) return;
    e.preventDefault();
    const text = e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : "";
    void send({ type: "keyDown", key: e.key, code: e.code, text, modifiers: MODS(e) });
  });
  view.addEventListener("keyup", (e) => {
    if (e.target !== view) return;
    e.preventDefault();
    void send({ type: "keyUp", key: e.key, code: e.code, modifiers: MODS(e) });
  });
  view.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text) {
      e.preventDefault();
      void send({ type: "insertText", text });
    }
  });

  // ---- touch (phone) ----
  const touches = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  let gesture: "none" | "tap" | "scroll" | "pinch" | "touch" = "none";
  let pinch0: { dist: number; mx: number; my: number; zoom: typeof zoom } | null = null;
  const mid = () => {
    const [a, b] = [...touches.values()];
    return { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
  };
  const touchPoints = () =>
    [...touches.entries()].flatMap(([pid, t]) => {
      const p = pointAt({ clientX: t.x, clientY: t.y });
      return p ? [{ ...p, id: pid % 10 }] : [];
    });
  view.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    e.preventDefault();
    view.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    if (touches.size === 2) {
      // Two fingers: zoom and pan the view. Nothing is sent to the page.
      if (gesture === "touch") void send({ type: "touchCancel", touchPoints: [] });
      gesture = "pinch";
      zoomTarget = null;
      pinch0 = { ...mid(), zoom: { ...zoom } };
    } else if (touches.size === 1) {
      gesture = "tap";
      // A mobile site gets the real touch sequence as it happens.
      if (mobileSite()) {
        gesture = "touch";
        void send({ type: "touchStart", touchPoints: touchPoints() });
      }
    }
  });
  view.addEventListener("pointermove", (e) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    t.x = e.clientX;
    t.y = e.clientY;
    if (gesture === "pinch" && pinch0 && touches.size === 2) {
      const m = mid();
      const s = Math.min(5, Math.max(1, (pinch0.zoom.s * m.dist) / pinch0.dist));
      const r = view.getBoundingClientRect();
      // Keep the point between the fingers under the fingers.
      const ox = pinch0.mx - r.left;
      const oy = pinch0.my - r.top;
      zoom = { s, x: m.mx - r.left - ((ox - pinch0.zoom.x) * s) / pinch0.zoom.s, y: m.my - r.top - ((oy - pinch0.zoom.y) * s) / pinch0.zoom.s };
      if (s === 1) zoom = { s: 1, x: 0, y: 0 };
      applyTransform();
      return;
    }
    if (gesture === "touch") {
      const now = performance.now();
      if (now - lastMove < 33) return;
      lastMove = now;
      void send({ type: "touchMove", touchPoints: touchPoints() });
      return;
    }
    if (gesture === "tap" && Math.hypot(t.x - t.x0, t.y - t.y0) > TAP_SLOP) gesture = "scroll";
    if (gesture === "scroll") {
      // One finger on a desktop site scrolls the page under the finger, like a trackpad.
      const p = pointAt({ clientX: t.x0, clientY: t.y0 }) ?? { x: page.w / 2, y: page.h / 2 };
      const k = page.w / img.getBoundingClientRect().width;
      void send({ type: "mouseWheel", ...p, deltaX: -dx * k, deltaY: -dy * k });
    }
  });
  const endTouch = async (e: PointerEvent) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    touches.delete(e.pointerId);
    if (gesture === "touch") {
      if (touches.size === 0) {
        gesture = "none";
        const p = pointAt({ clientX: t.x0, clientY: t.y0 });
        const field = p && e.type === "pointerup" ? fieldAt(fields, p) : null;
        if (field) startTyping(field, true);
        await send({ type: e.type === "pointercancel" ? "touchCancel" : "touchEnd", touchPoints: [] });
      }
      return;
    }
    if (gesture === "tap" && e.type === "pointerup") {
      gesture = "none";
      const p = pointAt({ clientX: t.x0, clientY: t.y0 });
      if (!p) return;
      // Tapped a text field: open the phone keyboard now, while this is still your tap (phones only open it
      // from a tap), and zoom to the field; the page's own focus confirms or corrects it a moment later.
      const field = fieldAt(fields, p);
      if (field) {
        startTyping(field, true);
        zoomTo(pad(field));
      }
      // The press lasts as long as the finger did (capped), not an HTTP round trip.
      const held = Math.min(800, Math.max(40, performance.now() - t.t0));
      void send({ type: "mouseMoved", ...p });
      void send({ type: "mousePressed", ...p, button: "left", clickCount: 1 });
      await sleep(held);
      void send({ type: "mouseReleased", ...p, button: "left", clickCount: 1 });
      return;
    }
    if (touches.size === 0) {
      gesture = "none";
      pinch0 = null;
    }
  };
  view.addEventListener("pointerup", (e) => void endTouch(e));
  view.addEventListener("pointercancel", (e) => void endTouch(e));

  // ---- done ----
  const done = async () => {
    try {
      await queue;
      const r = await api<{ verified: boolean; still?: string }>("POST", `/api/tickets/${id}/done`);
      if (r.verified) location.hash = "#/";
      else
        err.replaceChildren(
          `It still looks like a ${r.still} page. `,
          h("button", { class: "tk-btn small", type: "button", onclick: () => void takeoverWindow(id, d) }, "Take control again"),
        );
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
}
