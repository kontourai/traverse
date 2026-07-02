/**
 * A small, dependency-free robots.txt parser + matcher — enough to honor
 * `Disallow`/`Allow` for a single-page fetcher, not a full crawler's robots
 * engine. Deliberately minimal (no crawl-delay, no sitemap, no wildcard/`$`
 * pattern language): those are recorded as slice-3 candidates in
 * docs/slice-3-candidates.md.
 *
 * Matching model (a pragmatic subset of RFC 9309):
 *  - Group selection: the record group whose `User-agent` token is the best
 *    match for our UA's leading product token wins; a `*` group is the
 *    fallback. An exact/prefix product-token match beats `*`.
 *  - Path decision: among the selected group's rules, the one whose `path` is
 *    the LONGEST prefix of the request path decides; `Allow` wins ties with
 *    `Disallow` (least-restrictive-on-tie, per RFC 9309 §2.2.2). No matching
 *    rule => allowed.
 *  - `Disallow:` with an empty value means "allow everything"; `Disallow: /`
 *    blocks the whole origin.
 */

import type { RobotsRules } from "./types.js";

/** The leading product token of a UA string, lowercased (e.g. "kontourai-traverse-bot"). */
export function productToken(userAgent: string): string {
  const first = userAgent.trim().split(/[\s/]+/)[0] ?? "";
  return first.toLowerCase();
}

interface RawGroup {
  agents: string[];
  rules: Array<{ path: string; allow: boolean }>;
}

/**
 * Parse robots.txt text into UA-keyed groups, then select the rules for
 * `userAgent`. Returns `{ rules: [] }` (allow-all) when no group applies.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const groups: RawGroup[] = [];
  let current: RawGroup | null = null;
  // A blank line or a non-agent directive after agents closes the "agent block"
  // so a following `User-agent` starts a new group rather than extending it.
  let sawRuleForCurrent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || sawRuleForCurrent) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRuleForCurrent = false;
      }
      if (value) current.agents.push(value.toLowerCase());
    } else if (field === "disallow" || field === "allow") {
      if (!current) continue; // rule with no preceding User-agent: ignore.
      sawRuleForCurrent = true;
      // `Disallow:` (empty) is an explicit allow-all for that path space.
      if (field === "disallow" && value === "") continue;
      current.rules.push({ path: value, allow: field === "allow" });
    }
    // other fields (crawl-delay, sitemap, host, ...) are intentionally ignored.
  }

  const token = productToken(userAgent);
  let best: RawGroup | undefined;
  let bestScore = -1;
  for (const g of groups) {
    for (const agent of g.agents) {
      // score: exact token match (3) > our-token-starts-with-agent prefix (2) >
      // wildcard "*" (1). Longer specific matches beat "*".
      let score = -1;
      if (agent === "*") score = 1;
      else if (agent === token) score = 3;
      else if (token.startsWith(agent) || agent.startsWith(token)) score = 2;
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
  }

  return { rules: best ? best.rules : [] };
}

/**
 * Decide whether `pathname` (URL path + query) is allowed by `rules`.
 * Longest-prefix wins; Allow beats Disallow on an equal-length tie.
 */
export function isPathAllowed(rules: RobotsRules, pathname: string): boolean {
  let decision = true; // default allow
  let matchLen = -1;
  for (const rule of rules.rules) {
    if (rule.path === "") continue;
    if (!pathname.startsWith(rule.path)) continue;
    const len = rule.path.length;
    if (len > matchLen || (len === matchLen && rule.allow)) {
      matchLen = len;
      decision = rule.allow;
    }
  }
  return decision;
}
