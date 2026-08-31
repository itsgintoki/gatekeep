import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 5_000;

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function badWebhookUrl(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return withoutBrackets.replace(/\.$/, "");
}

function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (family === 0) {
    throw badWebhookUrl("Webhook hostname did not resolve to a valid IP address");
  }

  const blocked = blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
  if (blocked) {
    throw badWebhookUrl("Webhook URLs cannot target private or reserved networks");
  }
}

function parseWebhookUrl(rawUrl: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    throw badWebhookUrl("Webhook URL is invalid");
  }

  if (url.protocol !== "https:") {
    throw badWebhookUrl("Webhook URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw badWebhookUrl("Webhook URL cannot contain credentials");
  }

  return url;
}

async function resolvePublicAddresses(hostname: string): Promise<void> {
  const normalized = normalizeHostname(hostname);
  const literalFamily = isIP(normalized);
  if (literalFamily !== 0) {
    assertPublicAddress(normalized);
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw badWebhookUrl("Webhook hostname could not be resolved");
  }

  if (addresses.length === 0) {
    throw badWebhookUrl("Webhook hostname did not resolve to an address");
  }
  for (const { address } of addresses) {
    assertPublicAddress(address);
  }
}

export async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  const url = parseWebhookUrl(rawUrl);
  await resolvePublicAddresses(url.hostname);
  return url;
}

const safeLookup: LookupFunction = (hostname, _options, callback) => {
  const normalized = normalizeHostname(hostname);
  lookup(normalized, { all: true, verbatim: true })
    .then((addresses) => {
      if (addresses.length === 0) {
        callback(Object.assign(new Error("Webhook hostname did not resolve"), { code: "ENOTFOUND" }), "", 4);
        return;
      }
      for (const { address } of addresses) {
        assertPublicAddress(address);
      }
      const selected = addresses[0];
      callback(null, selected.address, selected.family);
    })
    .catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error(String(error)), "", 4);
    });
};

interface WebhookResponse {
  status: number;
  location?: string;
}

function postOnce(url: URL, body: string, headers: Record<string, string>): Promise<WebhookResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<WebhookResponse>();
  const req = request(
    url,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": String(Buffer.byteLength(body)),
      },
      lookup: safeLookup,
      timeout: REQUEST_TIMEOUT_MS,
    },
    (response) => {
      response.resume();
      response.once("end", () => {
        const location = typeof response.headers.location === "string"
          ? response.headers.location
          : undefined;
        resolve({ status: response.statusCode ?? 500, location });
      });
    }
  );

  req.once("timeout", () => req.destroy(new Error("Webhook request timed out")));
  req.once("error", reject);
  req.end(body);
  return promise;
}

export async function postWebhook(
  rawUrl: string,
  body: string,
  headers: Record<string, string>
): Promise<number> {
  let url = parseWebhookUrl(rawUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await postOnce(url, body, headers);
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    if (!isRedirect) {
      return response.status;
    }
    if (!response.location || redirects === MAX_REDIRECTS) {
      throw new Error("Webhook redirected too many times or omitted a Location header");
    }

    url = parseWebhookUrl(response.location, url);
  }

  throw new Error("Webhook redirected too many times");
}
