// SPDX-License-Identifier: AGPL-3.0-only
// The contract (AGENTS.md rule 9): every tool, setting and route, in zod with .describe().
// server/src/capabilities.ts turns this into MCP tools and OpenAPI. Nothing hand-writes tool schemas.
import { z } from "zod";

// ---------- settings ----------

export const SiteLevel = z
  .enum(["blocked", "read", "read_as_you", "act_as_you"])
  .describe("Site ladder: blocked < read (anonymous profile) < read_as_you (your logins) < act_as_you (post, vote, save as you).");
export type SiteLevel = z.infer<typeof SiteLevel>;
export const LEVEL_RANK: Record<SiteLevel, number> = { blocked: 0, read: 1, read_as_you: 2, act_as_you: 3 };

export const Device = z
  .enum(["narrow", "desktop", "mobile"])
  .describe("How the site sees the browser (ADR 0028). narrow (default): the desktop browser in a window as narrow as Chrome allows, shaped like a phone screen, so responsive sites use their phone layout. desktop: a full-size window. mobile: an emulated phone (ADR 0006).");

export const SiteRule = z.object({
  pattern: z.string().describe("Registrable domain (reddit.com) or a specific host (mail.google.com). The most specific rule wins."),
  level: SiteLevel,
  adblock: z.boolean().describe("Ad and tracker blocking (ADR 0003). On by default.").default(true),
  device: Device.default("narrow"),
  source: z.enum(["default", "user", "approval", "ticket"]).describe("Where this rule came from."),
});
export type SiteRule = z.infer<typeof SiteRule>;

export const TokenKind = z.enum(["read", "act"]).describe("read: navigate, read, click, tighten only. act: also acts on act_as_you sites and calls every setting; loosening becomes a proposal.");
export type TokenKind = z.infer<typeof TokenKind>;

export const GrantScope = z.enum(["once", "task", "always"]).describe("once: this request. task: this token, site and action class until the task ends or 1 h idle. always: site and action class, lapses after 90 days unused.");
export type GrantScope = z.infer<typeof GrantScope>;

export const ActionClass = z
  .enum(["write", "comment", "vote", "save", "message", "pay", "delete", "credentials", "oauth", "sensitive_path", "taint_exit", "login_use"])
  .describe("What kind of consequence a held request has.");
export type ActionClass = z.infer<typeof ActionClass>;
/** Irreversible or private: these always ask, and "always" grants don't apply. */
export const ALWAYS_ASK: ReadonlySet<ActionClass> = new Set(["pay", "delete", "credentials", "oauth", "message", "sensitive_path"]);

// ---------- tool results ----------

export const TicketRef = z.object({
  id: z.string().describe("Ticket id. Pass it to wait_for_ticket."),
  kind: z.enum(["approval", "proposal", "challenge"]),
  expiresAt: z.string().describe("ISO time; unanswered tickets expire after 15 minutes."),
});

export const ToolResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), data: z.unknown().describe("Tool-specific payload.") }),
  z.object({ state: z.literal("blocked"), reason: z.string(), ticket: TicketRef, hint: z.string() }).describe("A captcha, login or block wall. A person resolves it; call wait_for_ticket."),
  z.object({ state: z.literal("pending_approval"), ticket: TicketRef, summary: z.string(), hint: z.string() }).describe("Something needs a person's approval."),
  z.object({ state: z.literal("denied"), reason: z.string() }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);
export type ToolResult = z.infer<typeof ToolResult>;

// ---------- tools ----------

export type ToolClass = "read" | "tighten" | "loosen" | "act";

export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  /** Lowest token kind that may call it. */
  minToken: TokenKind;
  /** read: no consequences. tighten: applies at once from any token. loosen: act token only, becomes a proposal. act: may hit the network gate. */
  class: ToolClass;
}

const def = <I extends z.ZodType>(d: ToolDef<I>) => d;

const Until = z
  .union([
    z.object({ items: z.number().int().min(1).max(500).describe("Stop after this many distinct items.") }),
    z.object({ end: z.literal(true).describe("Scroll until the feed ends.") }),
    z.object({ tokens: z.number().int().min(100).max(20000).describe("Stop after roughly this many tokens of items.") }),
  ])
  .describe("When to stop scrolling.");

export const TOOLS = {
  open: def({
    name: "open",
    description:
      "Open a URL in this session's tab. The site's level decides the profile: read opens anonymously, read_as_you uses your logins. Returns the page title and URL; call read for content. If the URL is a link on the current page, Crossbar clicks that link, as a person would. Go to pages the way a person does (from the list, then each item) rather than guessing addresses.",
    input: z.object({ url: z.string().url().describe("http(s) URL to open.") }),
    minToken: "read",
    class: "read",
  }),
  read: def({
    name: "read",
    description: "Read the current page as markdown. Interactive elements carry refs like [e12] that click and type accept. mode content+links also lists every visible link and button with its ref and page region.",
    input: z.object({
      mode: z.enum(["content", "content+links"]).default("content").describe("content: markdown only. content+links: also the links pass."),
      maxChars: z.number().int().min(500).max(200000).default(40000).describe("Truncate content to this many characters."),
    }),
    minToken: "read",
    class: "read",
  }),
  click: def({
    name: "click",
    description:
      "Click an element: by ref from read (preferred), or by its visible text when it has no ref (e.g. an option in a custom menu). Clicking is reading; if the click sends a request with consequences (posting, paying, deleting), it is held and a person is asked.",
    input: z
      .object({
        ref: z.string().regex(/^e\d+$/).optional().describe("Element ref from read, e.g. e12."),
        text: z.string().min(1).max(200).optional().describe("Fallback: the visible text of what to click, as a person reads it (exact match first, then partial)."),
        nth: z.number().int().min(0).max(50).default(0).describe("With text: which match, if several (0 = first on the page)."),
      })
      .refine((v) => !!v.ref || !!v.text, { message: "Give a ref or a text." }),
    minToken: "read",
    class: "act",
  }),
  type: def({
    name: "type",
    description: "Type text into the field with this ref, key by key. Set submit to press Enter afterwards. To have the person sign in instead, use ask_person.",
    input: z.object({
      ref: z.string().regex(/^e\d+$/).describe("Field ref from read."),
      text: z.string().max(10000).describe("Text to type."),
      submit: z.boolean().default(false).describe("Press Enter after typing."),
    }),
    minToken: "read",
    class: "act",
  }),
  scroll: def({
    name: "scroll",
    description: "Scroll the page with real wheel events, collecting items while scrolling (works on virtualized feeds). Says why it stopped: target, end, no_growth or cap.",
    input: z.object({
      until: Until,
      selector: z.string().max(200).optional().describe("CSS selector for items. Defaults to the site adapter's, else article, [role=article], li."),
    }),
    minToken: "read",
    class: "read",
  }),
  back: def({ name: "back", description: "Go back one page in this tab.", input: z.object({}), minToken: "read", class: "read" }),
  ask_person: def({
    name: "ask_person",
    description:
      "Hand the current page to the person when only they can go on: logging in, a check you can't pass, confirming a payment, or a step you mustn't take yourself. They get a notification and take control of this tab; your session is paused on it. Call wait_for_ticket, then read again. Never ask for passwords or codes in chat; use this instead.",
    input: z.object({
      need: z.enum(["login", "captcha", "verification", "other"]).describe("login: they sign in. captcha: a check only a person can pass. verification: a bank or 2-step confirmation. other: anything else only they can do."),
      reason: z.string().min(1).max(300).describe("One sentence for the person, e.g. 'Sign in so I can read your RFQ replies.' Shown as your words, marked unverified."),
    }),
    minToken: "read",
    class: "read",
  }),
  wait_for_ticket: def({
    name: "wait_for_ticket",
    description: "Wait for a ticket (approval, proposal or challenge) to be resolved by a person. Returns its state; on resolved, retry what you were doing.",
    input: z.object({ ticket: z.string().describe("Ticket id."), timeoutSeconds: z.number().int().min(1).max(60).default(30).describe("How long to wait in this call.") }),
    minToken: "read",
    class: "read",
  }),
  list_activity: def({
    name: "list_activity",
    description: "Your own recent activity rows: where requests went, the shape of the data they carried (no values), and the outcome.",
    input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    minToken: "read",
    class: "read",
  }),
  list_flags: def({ name: "list_flags", description: "Domains flagged as hostile, with the reason.", input: z.object({}), minToken: "read", class: "read" }),
  flag_domain: def({
    name: "flag_domain",
    description: "Mark a domain as hostile. Only tightens, so it applies at once: the domain becomes blocked.",
    input: z.object({ domain: z.string().min(3).max(253).describe("Registrable domain or host."), reason: z.string().max(500).describe("Why. Shown to the person as unverified.") }),
    minToken: "read",
    class: "tighten",
  }),
  list_sites: def({ name: "list_sites", description: "Your site rules: level, ad blocking and device per site.", input: z.object({}), minToken: "read", class: "read" }),
  set_site: def({
    name: "set_site",
    description: "Change a site's level or options. Tightening (lower level, ad blocking on) applies at once. Loosening needs an act token and becomes a proposal a person approves.",
    input: z.object({
      pattern: z.string().min(3).max(253).describe("Registrable domain or host."),
      level: SiteLevel.optional(),
      adblock: z.boolean().optional(),
      device: Device.optional(),
      reason: z.string().max(500).default("").describe("Why. Quoted to the person as unverified."),
    }),
    minToken: "read",
    class: "loosen",
  }),
  list_grants: def({ name: "list_grants", description: "Active approval grants for this agent.", input: z.object({}), minToken: "read", class: "read" }),
  revoke_grant: def({ name: "revoke_grant", description: "Revoke a grant. Only tightens.", input: z.object({ id: z.string() }), minToken: "read", class: "tighten" }),
  panic: def({
    name: "panic",
    description: "Stop everything: suspends every token, drops act and signed-in grants, closes sessions. Only a person can resume.",
    input: z.object({ reason: z.string().max(500).default("") }),
    minToken: "read",
    class: "tighten",
  }),
} as const;

export type ToolName = keyof typeof TOOLS;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOLS)[N]["input"]>;

// ---------- HTTP routes ----------

export type RouteAuth = "public" | "session" | "token" | "either";

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** Deny by default (AGENTS.md rule 11): every route declares its login. */
  auth: RouteAuth;
  /** Session routes that loosen access need a fresh second factor when 2FA is on. */
  freshFactor?: boolean;
  /** Only the owner (household admin). */
  ownerOnly?: boolean;
  description: string;
  body?: z.ZodType;
}

const r = (d: RouteDef) => d;

export const ApproveBody = z.object({ scope: GrantScope.default("task") });
export const LoginBody = z.object({ username: z.string().max(64), password: z.string().max(256), totp: z.string().max(10).optional(), recoveryCode: z.string().max(40).optional() });
export const CreateTokenBody = z.object({ agentName: z.string().min(1).max(64).describe("Written on every audit row."), kind: TokenKind.default("read") });
export const SiteBody = z.object({ pattern: z.string().min(3).max(253), level: SiteLevel.optional(), adblock: z.boolean().optional(), device: Device.optional() });
export const NotifyBody = z.object({ ntfyUrl: z.string().url().nullable().describe("ntfy topic URL, e.g. https://ntfy.sh/my-secret-topic. null turns notifications off.") });
export const CategoryBody = z.object({
  category: z.enum(["banking", "mail", "passwords", "cloud", "signin", "government"]).describe("Sensitive category (ADR 0014)."),
  enabled: z.boolean().describe("On: agents may use these sites under the normal ladder. Off: blocked for agents."),
});
export const InviteBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(10).max(256) });
export const TotpEnableBody = z.object({ secret: z.string(), code: z.string() });
export const PasswordBody = z.object({ current: z.string(), next: z.string().min(10).max(256) });
export const TakeoverInput = z.object({
  type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel", "keyDown", "keyUp", "char", "insertText", "touchStart", "touchMove", "touchEnd", "touchCancel"]),
  /** The tab this event was aimed at. If control moved to another tab meanwhile, the event is refused, never replayed there (ADR 0016). */
  tab: z.string().max(64).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  button: z.enum(["left", "right", "middle", "none"]).optional(),
  /** Buttons held during a move (1 left, 2 right, 4 middle), so drags select text and move sliders. */
  buttons: z.number().int().min(0).max(7).optional(),
  clickCount: z.number().int().min(0).max(3).optional(),
  /** Alt 1, Ctrl 2, Meta 4, Shift 8. */
  modifiers: z.number().int().min(0).max(15).optional(),
  touchPoints: z.array(z.object({ x: z.number(), y: z.number(), id: z.number().int().min(0).max(9) })).max(5).optional(),
  key: z.string().max(32).optional(),
  code: z.string().max(32).optional(),
  text: z.string().max(2000).optional(),
});

export const ROUTES: RouteDef[] = [
  r({ method: "GET", path: "/healthz", auth: "public", description: "Liveness." }),
  r({ method: "POST", path: "/api/login", auth: "public", description: "Password login, then TOTP or recovery code when 2FA is on.", body: LoginBody }),
  r({ method: "POST", path: "/api/passkey/login/options", auth: "public", description: "Passkey login challenge." }),
  r({ method: "POST", path: "/api/passkey/login/verify", auth: "public", description: "Verify a passkey assertion and start a session." }),
  r({ method: "POST", path: "/api/logout", auth: "session", description: "End this session." }),
  r({ method: "GET", path: "/api/me", auth: "session", description: "Current user and 2FA state." }),
  r({ method: "POST", path: "/api/me/password", auth: "session", freshFactor: true, description: "Change password.", body: PasswordBody }),
  r({ method: "POST", path: "/api/me/totp/begin", auth: "session", description: "Start TOTP enrolment; returns a secret and otpauth URL." }),
  r({ method: "POST", path: "/api/me/totp/enable", auth: "session", description: "Confirm TOTP with a code; returns recovery codes.", body: TotpEnableBody }),
  r({ method: "POST", path: "/api/me/passkey/options", auth: "session", description: "Passkey registration options." }),
  r({ method: "POST", path: "/api/me/passkey/verify", auth: "session", description: "Finish passkey registration; returns recovery codes if none exist." }),
  r({ method: "POST", path: "/api/me/reauth", auth: "session", description: "Fresh second factor (TOTP code or passkey) for approvals that loosen access.", body: z.object({ totp: z.string().optional() }) }),
  r({ method: "POST", path: "/api/me/reauth/passkey/options", auth: "session", description: "Passkey challenge for a fresh check." }),
  r({ method: "POST", path: "/api/me/reauth/passkey/verify", auth: "session", description: "Verify a passkey for a fresh check." }),
  r({ method: "GET", path: "/api/users", auth: "session", ownerOnly: true, description: "Household members." }),
  r({ method: "POST", path: "/api/users", auth: "session", ownerOnly: true, description: "Invite a household member.", body: InviteBody }),
  r({ method: "GET", path: "/api/tokens", auth: "session", description: "Your agent tokens (never the secret)." }),
  r({ method: "POST", path: "/api/tokens", auth: "session", description: "Create an agent token; the secret is shown once.", body: CreateTokenBody }),
  r({ method: "DELETE", path: "/api/tokens/:id", auth: "session", description: "Revoke a token." }),
  r({ method: "GET", path: "/api/sites", auth: "either", description: "Your site rules." }),
  r({ method: "PUT", path: "/api/sites", auth: "session", freshFactor: true, description: "Set a site rule directly (a person, so no proposal).", body: SiteBody }),
  r({ method: "GET", path: "/api/tickets", auth: "session", description: "Open tickets: approvals, proposals, challenges." }),
  r({ method: "GET", path: "/api/tickets/:id", auth: "session", description: "One ticket, with the facts the browser observed." }),
  r({ method: "POST", path: "/api/tickets/:id/approve", auth: "session", freshFactor: true, description: "Approve (human only; no token can approve).", body: ApproveBody }),
  r({ method: "POST", path: "/api/tickets/:id/deny", auth: "session", description: "Deny. Only tightens." }),
  r({ method: "POST", path: "/api/tickets/:id/deny-link", auth: "public", description: "Inline Deny from a notification, authorised by a signed link. Only tightens." }),
  r({ method: "GET", path: "/api/tickets/:id/screenshot", auth: "session", description: "Screenshot taken when the request was held." }),
  r({ method: "POST", path: "/api/tickets/:id/claim", auth: "session", description: "Take control to resolve a challenge (human takeover resolver). Taking control again of a ticket you hold re-attaches." }),
  r({ method: "POST", path: "/api/tickets/:id/release", auth: "session", description: "Leave a takeover without finishing: the ticket goes back to open." }),
  r({ method: "POST", path: "/api/tickets/:id/done", auth: "session", description: "I'm done: run the verifier on a challenge." }),
  r({ method: "POST", path: "/api/tickets/:id/not-a-wall", auth: "session", description: "A person says a challenge is a false alarm: close it and let the agent continue (ADR 0013)." }),
  r({ method: "POST", path: "/api/tickets/:id/input", auth: "session", description: "Takeover input event.", body: TakeoverInput }),
  r({ method: "GET", path: "/api/tickets/:id/view", auth: "session", description: "Takeover: the focused field, its form and the text fields on screen (kinds and positions only), so the viewer can keep typing in view." }),
  r({ method: "GET", path: "/api/grants", auth: "session", description: "Your grants." }),
  r({ method: "DELETE", path: "/api/grants/:id", auth: "session", description: "Revoke a grant." }),
  r({ method: "GET", path: "/api/activity", auth: "session", description: "Your activity log (shapes, no values)." }),
  r({ method: "GET", path: "/api/flags", auth: "either", description: "Flagged domains." }),
  r({ method: "GET", path: "/api/live", auth: "session", description: "Live view: tabs and the latest frame." }),
  r({ method: "GET", path: "/api/live/:tab/frame", auth: "session", description: "Latest screencast frame (JPEG)." }),
  r({ method: "GET", path: "/api/live/:tab/stream", auth: "session", description: "Server-sent events: frames at up to 15 fps." }),
  r({ method: "POST", path: "/api/panic", auth: "either", description: "Panic. Only tightens." }),
  r({ method: "POST", path: "/api/resume", auth: "session", freshFactor: true, description: "Resume after panic (human only)." }),
  r({ method: "GET", path: "/api/settings/notifications", auth: "session", description: "Where notifications go." }),
  r({ method: "PUT", path: "/api/settings/notifications", auth: "session", freshFactor: true, description: "Change where notifications go (human only).", body: NotifyBody }),
  r({ method: "POST", path: "/api/settings/notifications/test", auth: "session", description: "Send a test notification." }),
  r({ method: "GET", path: "/api/settings/categories", auth: "session", description: "Sensitive categories (banking, mail…) and whether agents may use them." }),
  r({ method: "PUT", path: "/api/settings/categories", auth: "session", freshFactor: true, description: "Turn a sensitive category on or off for agents (human only, ADR 0014).", body: CategoryBody }),
  r({ method: "GET", path: "/api/openapi.json", auth: "public", description: "OpenAPI document generated from this contract." }),
  r({ method: "POST", path: "/mcp", auth: "token", description: "MCP over streamable HTTP (JSON responses)." }),
  r({ method: "GET", path: "/mcp", auth: "token", description: "MCP: no server-initiated stream; returns 405." }),
  r({ method: "DELETE", path: "/mcp", auth: "token", description: "End an MCP session." }),
  r({ method: "POST", path: "/api/tools/:name", auth: "token", description: "Call a tool over plain HTTP, same contract as MCP." }),
  r({ method: "GET", path: "/", auth: "public", description: "Web app shell." }),
  r({ method: "GET", path: "/assets/:file", auth: "public", description: "Web app static assets." }),
];
