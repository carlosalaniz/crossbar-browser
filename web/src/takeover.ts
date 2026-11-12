// SPDX-License-Identifier: AGPL-3.0-only
// Take control: the remote page as a window you use directly. Phone first: tap, drag to scroll, pinch to
// zoom the view, a keyboard that types as you go. On desktop: mouse and keyboard go straight to the page.
// The device never changes (ADR 0015); input is ordered and bound to the tab it was aimed at (ADR 0016).
import { clientToPage, fitSize, originOf, textEdit } from "./logic.ts";

type Child = Node | string | null | undefined | false | Child[];
export interface TakeoverDeps {
  h(tag: string, attrs?: Record<string, unknown>, ...children: Child[]): HTMLElement;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  render(node: HTMLElement): void;
  onCleanup(fn: () => void): void;
}

interface Claim {
  tab: string;
  origin: string;
}
type Focus = "text" | "password" | "otp" | "frame" | "none";
interface InputReply {
  tab: string;
  url: string;
  focus?: Focus;
}

const TAP_SLOP = 10;
const MODS = (e: KeyboardEvent | MouseEvent | WheelEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export async function takeoverWindow(id: string, d: TakeoverDeps): Promise<void> {
  const { h, api } = d;
  let claim: Claim;
  try {
    claim = await api<Claim>("POST", `/api/tickets/${id}/claim`);
  } catch (e) {
    d.render(h("div", { class: "tk" }, h("div", { class: "tk-msg" }, h("p", { class: "error" }, (e as Error).message), h("a", { class: "btn", href: `#/tickets/${id}` }, "Back"))));
    return;
  }

  let current = claim.tab;
  let page = { w: 1280, h: 800 };
  let zoom = { s: 1, x: 0, y: 0 };
  const mobileSite = () => page.w <= 600;

  // ---- elements ----
  const img = h("img", { class: "tk-img", alt: "The page you're controlling", draggable: "false" }) as HTMLImageElement;
  const stage = h("div", { class: "tk-stage" }, img);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const hint = h("div", { class: "tk-hint" }, coarse ? "Tap to click · drag to scroll · pinch to zoom" : "Click the page to control it. Mouse and keyboard go straight to it.");
  const view = h("div", { class: "tk-view", tabindex: "0", "aria-label": "Remote page. Click to control it." }, stage, hint);
  setTimeout(() => hint.classList.add("gone"), 4000);
  const originText = h("span", { class: "tk-origin-text" }, originOf(claim.origin));
  const lock = h("span", { class: "tk-lock", "aria-hidden": "true" }, claim.origin.startsWith("https:") ? "🔒" : "⚠︎");
  const status = h("span", { class: "tk-status", title: "Round trip to the browser" }, "connecting…");
  const banner = h("div", { class: "tk-banner", hidden: true });
  const err = h("p", { class: "tk-error", role: "alert" });
  const kbd = h("input", { class: "tk-kbd", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Type into the page", enterkeyhint: "go" }) as HTMLInputElement;
  const kbdBtn = h("button", { class: "tk-btn", type: "button", onclick: () => openKeyboard() }, "⌨︎ Keyboard");
  const more = h(
    "div",
    { class: "tk-more", hidden: true },
    ...[["Tab", "Tab"], ["Enter", "Enter"], ["Esc", "Escape"], ["⌫", "Backspace"], ["←", "ArrowLeft"], ["→", "ArrowRight"]].map(([label, key]) => h("button", { class: "tk-btn", type: "button", onclick: () => key!.length && pressKey(key!) }, label!)),
    h("button", { class: "tk-btn", type: "button", onclick: () => resetZoom() }, "Fit"),
    h("button", {
      class: "tk-btn",
      type: "button",
      onclick: async () => {
        await api("POST", `/api/tickets/${id}/not-a-wall`).catch((e) => (err.textContent = (e as Error).message));
        location.hash = "#/";
      },
    }, "Not a wall — let the agent go on"),
  );
  const doneBtn = h("button", { class: "tk-btn primary", type: "button", onclick: () => void done() }, "Done");

  d.render(
    h(
      "div",
      { class: "tk" },
      h(
        "header",
        { class: "tk-bar" },
        h("a", { class: "tk-close", href: `#/tickets/${id}`, "aria-label": "Leave (the page stays as it is)" }, "✕"),
        // The real origin, drawn by Crossbar outside the stream, so the page can't fake it.
        h("div", { class: "tk-origin" }, lock, originText),
        status,
      ),
      banner,
      view,
      err,
      h("footer", { class: "tk-actions" }, kbdBtn, h("button", { class: "tk-btn", type: "button", onclick: () => (more.hidden = !more.hidden) }, "More"), doneBtn),
      more,
      kbd,
    ),
  );

  // ---- layout ----
  const layout = () => {
    const r = view.getBoundingClientRect();
    const fit = fitSize(page, { w: r.width, h: r.height }, matchMedia("(pointer: coarse)").matches);
    img.style.width = `${fit.w}px`;
    img.style.height = `${fit.h}px`;
    stage.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  };
  const resetZoom = () => {
    zoom = { s: 1, x: 0, y: 0 };
    layout();
  };
  const ro = new ResizeObserver(layout);
  ro.observe(view);
  d.onCleanup(() => ro.disconnect());

  // ---- stream ----
  const onUrl = (u: string) => {
    originText.textContent = originOf(u);
    lock.textContent = u.startsWith("https:") ? "🔒" : "⚠︎";
    const differs = originOf(u) !== originOf(claim.origin);
    banner.hidden = !differs;
    banner.textContent = differs ? `Now on ${originOf(u)}. Check it before typing a password.` : "";
  };
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
    startStream();
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
        if (r.focus) onFocus(r.focus);
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
  const touchPoints = () => [...touches.entries()].flatMap(([pid, t]) => {
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
      layout();
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
        await send({ type: e.type === "pointercancel" ? "touchCancel" : "touchEnd", touchPoints: [] });
      }
      return;
    }
    if (gesture === "tap" && e.type === "pointerup") {
      gesture = "none";
      const p = pointAt({ clientX: t.x0, clientY: t.y0 });
      if (!p) return;
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

  // ---- keyboard (phone) ----
  // A real field, so the phone's keyboard, autocorrect and password manager work. What you type goes to
  // the page as you type it; a password-manager fill arrives whole, as it would on any site.
  let typed = "";
  const openKeyboard = () => {
    kbd.classList.add("on");
    kbd.focus();
  };
  const onFocus = (f: Focus) => {
    kbdBtn.classList.toggle("hint", f !== "none");
    kbd.type = f === "password" ? "password" : "text";
    kbd.autocomplete = f === "password" ? "current-password" : f === "otp" ? "one-time-code" : "on";
    kbd.inputMode = f === "otp" ? "numeric" : "text";
    if (f === "none") return;
    if (matchMedia("(pointer: coarse)").matches) openKeyboard();
    else view.focus();
  };
  kbd.addEventListener("input", () => {
    const { backspaces, insert } = textEdit(typed, kbd.value);
    typed = kbd.value;
    for (let i = 0; i < backspaces; i++) pressKey("Backspace");
    if (insert) void send({ type: "insertText", text: insert });
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
  kbd.addEventListener("blur", () => {
    kbd.classList.remove("on");
    kbd.value = typed = "";
  });
  const pressKey = (key: string) => {
    void send({ type: "keyDown", key, code: key, text: key === "Enter" ? "\r" : "" });
    void send({ type: "keyUp", key, code: key });
  };

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
