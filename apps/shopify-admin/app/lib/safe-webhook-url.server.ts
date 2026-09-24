import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

type ResolvedAddress = { address: string; family: number };
type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type SafeWebhookDestination = {
  url: URL;
  address: string;
  family: 4 | 6;
};

const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6.addSubnet(address, prefix, "ipv6");
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family === 6) return !blockedIpv6.check(address, "ipv6");
  return false;
}

async function resolveAll(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Validates a merchant-provided webhook destination before every request.
 * HTTPS-only, no credentials/custom ports, and every resolved address must be
 * publicly routable. Redirects are separately disabled by the caller.
 */
export async function resolveSafeWebhookDestination(
  rawUrl: string,
  resolver: Resolver = resolveAll,
): Promise<SafeWebhookDestination> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Webhook URL is invalid");
  }

  if (url.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");
  if (url.username || url.password) throw new Error("Webhook URL must not contain credentials");
  if (url.port && url.port !== "443") throw new Error("Webhook URL must use the default HTTPS port");

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Webhook URL must use a public hostname");
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname);

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Webhook URL resolves to a private or reserved address");
  }

  const destination = addresses[0];
  if (!destination || (destination.family !== 4 && destination.family !== 6)) {
    throw new Error("Webhook destination did not resolve to a supported IP address");
  }

  return { url, address: destination.address, family: destination.family };
}

export async function assertSafeWebhookUrl(
  rawUrl: string,
  resolver: Resolver = resolveAll,
): Promise<URL> {
  return (await resolveSafeWebhookDestination(rawUrl, resolver)).url;
}

export function buildPinnedHttpsRequestOptions(
  destination: SafeWebhookDestination,
  request: { method?: string; headers?: Record<string, string> } = {},
): RequestOptions {
  return {
    protocol: "https:",
    hostname: destination.address,
    family: destination.family,
    port: destination.url.port ? Number(destination.url.port) : 443,
    servername: destination.url.hostname,
    path: `${destination.url.pathname}${destination.url.search}`,
    method: request.method ?? "POST",
    headers: { Host: destination.url.host, ...request.headers },
  };
}

export async function postJsonToSafeWebhook(
  rawUrl: string,
  request: {
    body: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<{ status: number }> {
  const destination = await resolveSafeWebhookDestination(rawUrl);
  const options = buildPinnedHttpsRequestOptions(destination, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(request.body).toString(),
      ...request.headers,
    },
  });

  return new Promise((resolve, reject) => {
    const outbound = httpsRequest(options, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    outbound.setTimeout(request.timeoutMs ?? 10_000, () => {
      outbound.destroy(new Error("Webhook request timed out"));
    });
    outbound.once("error", reject);
    outbound.end(request.body);
  });
}
