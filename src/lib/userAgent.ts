export interface ParsedUserAgent {
  browser: string;
  os: string;
  device: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
}

/**
 * parseUserAgent — Extracts structured browser, OS, and device categories
 * from a raw User-Agent header string.
 */
export function parseUserAgent(ua: string | undefined | null): ParsedUserAgent {
  if (!ua) {
    return { browser: "Unknown", os: "Unknown", device: "unknown" };
  }

  const uaLower = ua.toLowerCase();

  // 1. Detect Bots & Crawlers first
  if (
    uaLower.includes("bot") ||
    uaLower.includes("crawler") ||
    uaLower.includes("spider") ||
    uaLower.includes("slurp") ||
    uaLower.includes("discordbot") ||
    uaLower.includes("slackbot") ||
    uaLower.includes("twitterbot")
  ) {
    return { browser: "Bot/Crawler", os: "Unknown", device: "bot" };
  }

  // 2. Detect Device Type
  let device: ParsedUserAgent["device"] = "desktop";
  if (uaLower.includes("ipad") || uaLower.includes("tablet") || uaLower.includes("kindle")) {
    device = "tablet";
  } else if (
    uaLower.includes("mobile") ||
    uaLower.includes("iphone") ||
    uaLower.includes("ipod") ||
    uaLower.includes("android")
  ) {
    device = "mobile";
  }

  // 3. Detect Operating System
  let os = "Unknown";
  if (ua.includes("Windows NT 10.0") || ua.includes("Windows NT 11.0")) os = "Windows 10/11";
  else if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("iPhone") || ua.includes("iPad") || ua.includes("iPod")) os = "iOS";
  else if (ua.includes("Mac OS X")) os = "macOS";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("Linux")) os = "Linux";

  // 4. Detect Browser (Order matters due to compatibility tokens)
  let browser = "Unknown";
  if (ua.includes("Edg/") || ua.includes("Edge/")) browser = "Microsoft Edge";
  else if (ua.includes("OPR/") || ua.includes("Opera/")) browser = "Opera";
  else if (ua.includes("Chrome/") && !ua.includes("Chromium")) browser = "Google Chrome";
  else if (ua.includes("Firefox/")) browser = "Mozilla Firefox";
  else if (ua.includes("Safari/") && !ua.includes("Chrome")) browser = "Apple Safari";
  else if (ua.includes("curl/") || ua.includes("PostmanRuntime") || ua.includes("HTTPie")) browser = "API Client";

  return { browser, os, device };
}
