// ============================================================================
// src/lib/userAgent.ts — TINY ZERO-DEP UA PARSER (for link analytics)
// ----------------------------------------------------------------------------
// parseUserAgent(raw UA string) -> { browser, os, device }. Rule-list based:
// checks lowercase UA for token substrings (BOT_TOKENS first so crawlers
// aren't misclassified as Chrome). Used in TWO places:
//   1. resolve.service consumeLink — stamps each accessLogs row at view time.
//   2. links.service getLinkAnalytics — backfills display names for old rows.
// Deliberately coarse (no versions) — enough for dashboard breakdowns
// without pulling in ua-parser-js. Unknown UAs -> "Unknown"/"unknown".
// ============================================================================
export interface ParsedUserAgent {
  browser: string;
  os: string;
  device: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
}

interface DetectionRule {
  label: string;
  includes: readonly string[];
  excludes?: readonly string[];
}

const BOT_TOKENS = [
  "bot",
  "crawler",
  "spider",
  "slurp",
  "discordbot",
  "slackbot",
  "twitterbot",
] as const;

const TABLET_TOKENS = ["ipad", "tablet", "kindle"] as const;
const MOBILE_TOKENS = ["mobile", "iphone", "ipod", "android"] as const;

const OS_RULES: readonly DetectionRule[] = [
  { label: "Windows 10/11", includes: ["windows nt 10.0", "windows nt 11.0"] },
  { label: "Windows", includes: ["windows"] },
  { label: "iOS", includes: ["iphone", "ipad", "ipod"] },
  { label: "macOS", includes: ["mac os x"] },
  { label: "Android", includes: ["android"] },
  { label: "Linux", includes: ["linux"] },
];

const BROWSER_RULES: readonly DetectionRule[] = [
  { label: "Microsoft Edge", includes: ["edg/", "edge/"] },
  { label: "Opera", includes: ["opr/", "opera/"] },
  { label: "Google Chrome", includes: ["chrome/"], excludes: ["chromium"] },
  { label: "Mozilla Firefox", includes: ["firefox/"] },
  { label: "Apple Safari", includes: ["safari/"], excludes: ["chrome"] },
  { label: "API Client", includes: ["curl/", "postmanruntime", "httpie"] },
];

function includesAny(value: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function detectLabel(
  value: string,
  rules: readonly DetectionRule[],
  fallback: string
): string {
  const match = rules.find(
    (rule) =>
      includesAny(value, rule.includes) &&
      (!rule.excludes || !includesAny(value, rule.excludes))
  );
  return match?.label ?? fallback;
}

export function parseUserAgent(ua: string | undefined | null): ParsedUserAgent {
  if (!ua) {
    return { browser: "Unknown", os: "Unknown", device: "unknown" };
  }

  const normalized = ua.toLowerCase();
  if (includesAny(normalized, BOT_TOKENS)) {
    return { browser: "Bot/Crawler", os: "Unknown", device: "bot" };
  }

  const device = includesAny(normalized, TABLET_TOKENS)
    ? "tablet"
    : includesAny(normalized, MOBILE_TOKENS)
      ? "mobile"
      : "desktop";

  return {
    browser: detectLabel(normalized, BROWSER_RULES, "Unknown"),
    os: detectLabel(normalized, OS_RULES, "Unknown"),
    device,
  };
}
