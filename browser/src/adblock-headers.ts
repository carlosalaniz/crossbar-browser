// SPDX-License-Identifier: AGPL-3.0-only
// uBlock Origin's `header=` network filters (ADR 0036): block a request by its response headers.
// @ghostery/adblocker drops these rules. uBO uses them for anti-adblock loaders whose addresses change on
// every page load (Ad-Shield's /script/<site>.js), so only a header the vendor's server always sends
// identifies them. The gate asks Chrome to pause such a request again when its response arrives.
import { parse as parseDomain } from "tldts-experimental";

export interface HeaderRule {
  /** The filter line it came from, for the activity log and tests. */
  source: string;
  url: RegExp;
  /** Resource types (Chrome's names) it applies to; empty: all. */
  types: Set<string>;
  party?: "1p" | "3p" | "strict1p" | "strict3p";
  /** Page hostnames: included (empty: any) and excluded (`~`). */
  domains: string[];
  notDomains: string[];
  /** Request hostnames (`to=`): included and excluded. */
  to: string[];
  notTo: string[];
  header: string;
  /** No value: the header only has to be present. */
  value?: RegExp | string;
}

const TYPES: Record<string, string[]> = {
  script: ["Script"],
  xhr: ["XHR", "Fetch"],
  xmlhttprequest: ["XHR", "Fetch"],
  image: ["Image"],
  stylesheet: ["Stylesheet"],
  css: ["Stylesheet"],
  font: ["Font"],
  media: ["Media"],
  frame: ["Document"],
  subdocument: ["Document"],
  ping: ["Ping"],
  other: ["Other"],
};
const PARTY: Record<string, HeaderRule["party"]> = { "1p": "1p", "first-party": "1p", "3p": "3p", "third-party": "3p", strict1p: "strict1p", strict3p: "strict3p" };
const KNOWN = /^(~?(script|xhr|xmlhttprequest|image|stylesheet|css|font|media|frame|subdocument|ping|other)|1p|3p|first-party|third-party|strict1p|strict3p|match-case|domain=|from=|to=|header=)/;

/** Inside `header=name:/regex/` before its closing slash (a regex may hold commas: `/, 1\.1 google$/`). */
function openHeaderRegex(cur: string): boolean {
  const m = /^header=[^:]+:\/(.*)$/.exec(cur);
  if (!m) return false;
  const body = m[1]!;
  // Closed when it ends in an unescaped "/" (or "/i").
  return !/(^|[^\\])\/i?$/.test(body);
}

/** Split a filter's options on commas, keeping escaped commas (`\,`) inside a header value. */
function splitOptions(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === ",") {
      cur += ",";
      i++;
    } else if (s[i] === "," && !openHeaderRegex(cur)) {
      out.push(cur);
      cur = "";
    } else cur += s[i];
  }
  out.push(cur);
  return out;
}

/** An ABP-style address pattern (`||host^path*`) as a regular expression. */
function patternToRegex(p: string, matchCase: boolean): RegExp {
  let head = "";
  let tail = "";
  if (p.startsWith("||")) {
    head = "^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?";
    p = p.slice(2);
  } else if (p.startsWith("|")) {
    head = "^";
    p = p.slice(1);
  }
  if (p.endsWith("|")) {
    tail = "$";
    p = p.slice(0, -1);
  }
  const body = p
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "^" ? "(?:[^\\w.%-]|$)" : c.replace(/[.+?${}()|[\]\\/]/g, "\\$&")))
    .join("");
  return new RegExp(head + body + tail, matchCase ? "" : "i");
}

/** Parse one filter line, or undefined when it isn't a header rule this matcher can apply exactly. */
export function parseHeaderRule(line: string): HeaderRule | undefined {
  line = line.trim();
  const at = line.indexOf("header=");
  if (at < 0 || line.startsWith("!") || line.startsWith("@@") || line.includes("#")) return undefined;
  // The options' `$`: for a /regex/ pattern, the first "/$" followed by a known option.
  let dollar = -1;
  if (line.startsWith("/")) {
    for (let i = line.indexOf("/$", 1); i >= 0 && i < at; i = line.indexOf("/$", i + 1)) {
      if (KNOWN.test(line.slice(i + 2))) {
        dollar = i + 1;
        break;
      }
    }
  } else dollar = line.lastIndexOf("$", at);
  if (dollar < 0) return undefined;
  const pattern = line.slice(0, dollar);
  const opts = splitOptions(line.slice(dollar + 1));
  const rule: HeaderRule = { source: line, url: /$^/, types: new Set(), domains: [], notDomains: [], to: [], notTo: [], header: "" };
  let matchCase = false;
  for (const o of opts) {
    const eq = o.indexOf("=");
    const k = eq < 0 ? o : o.slice(0, eq);
    const v = eq < 0 ? "" : o.slice(eq + 1);
    if (k === "match-case") matchCase = true;
    else if (TYPES[k]) for (const t of TYPES[k]) rule.types.add(t);
    else if (PARTY[k]) rule.party = PARTY[k];
    else if (k === "domain" || k === "from" || k === "to") {
      for (const d of v.split("|").filter(Boolean)) {
        const neg = d.startsWith("~");
        const name = (neg ? d.slice(1) : d).toLowerCase();
        if (name.includes("*") || name.startsWith("/")) return undefined; // entity or regex forms: not handled
        if (k === "to") (neg ? rule.notTo : rule.to).push(name);
        else (neg ? rule.notDomains : rule.domains).push(name);
      }
    } else if (k === "header") {
      const colon = v.indexOf(":");
      rule.header = (colon < 0 ? v : v.slice(0, colon)).toLowerCase();
      if (!rule.header || rule.header.startsWith("~")) return undefined;
      if (colon >= 0) {
        const val = v.slice(colon + 1);
        if (!val || val.startsWith("~")) return undefined;
        const m = /^\/(.+)\/(i?)$/.exec(val);
        try {
          rule.value = m ? new RegExp(m[1]!, m[2]) : val.toLowerCase();
        } catch {
          return undefined;
        }
      }
    } else return undefined; // an option this matcher doesn't know: skip the rule rather than over-block
  }
  if (!rule.header) return undefined;
  try {
    const re = /^\/(.+)\/$/.exec(pattern);
    rule.url = re ? new RegExp(re[1]!, matchCase ? "" : "i") : patternToRegex(pattern || "*", matchCase);
  } catch {
    return undefined;
  }
  return rule;
}

export function parseHeaderRules(text: string): HeaderRule[] {
  const out: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("header=")) continue;
    const r = parseHeaderRule(line);
    if (r) out.push(r);
  }
  return out;
}

const within = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));
const registrable = (host: string) => parseDomain(host).domain ?? host;

/** The rules whose address, type, party and domain parts match: the response then decides. */
export function candidates(rules: HeaderRule[], req: { url: string; resourceType: string }, pageUrl: string): HeaderRule[] {
  if (rules.length === 0) return [];
  let host: string;
  let page: string;
  try {
    host = new URL(req.url).hostname.toLowerCase();
    page = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  return rules.filter((r) => {
    if (r.types.size && !r.types.has(req.resourceType)) return false;
    if (r.party) {
      const sameSite = registrable(host) === registrable(page);
      if (r.party === "1p" && !sameSite) return false;
      if (r.party === "3p" && sameSite) return false;
      if (r.party === "strict1p" && host !== page) return false;
      if (r.party === "strict3p" && host === page) return false;
    }
    if (r.domains.length && !within(page, r.domains)) return false;
    if (within(page, r.notDomains)) return false;
    if (r.to.length && !within(host, r.to)) return false;
    if (within(host, r.notTo)) return false;
    return r.url.test(req.url);
  });
}

/** The first rule the response's headers satisfy. */
export function matchHeaders(rules: HeaderRule[], headers: Array<{ name: string; value: string }>): HeaderRule | undefined {
  for (const r of rules) {
    for (const h of headers) {
      if (h.name.toLowerCase() !== r.header) continue;
      if (r.value === undefined) return r;
      if (typeof r.value === "string" ? h.value.toLowerCase() === r.value : r.value.test(h.value)) return r;
    }
  }
  return undefined;
}
