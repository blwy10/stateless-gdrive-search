// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import dns from "node:dns";
import net from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent } from "undici";

/**
 * Validate that a user-supplied custom model endpoint is a public HTTPS URL:
 * https only, no embedded credentials, no query string or fragment, not a
 * blocked host, and every resolved IP address is public.
 *
 * This runs when settings are saved and when the agent starts, but DNS can
 * change between this check and the eventual request (a TOCTOU / DNS-rebinding
 * window), and a validated host can still answer with a redirect to an internal
 * address. The connect-time guard in {@link ssrfSafeDispatcher} closes those
 * gaps for the actual request.
 */
export async function validatePublicHttpsBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Endpoint must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Endpoint must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Endpoint must not include credentials");
  }
  if (parsed.hash || parsed.search) {
    throw new Error("Endpoint must not include query parameters or fragments");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error("Endpoint host is not allowed");
  }

  const addresses = await dns.promises.lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address.address))) {
    throw new Error("Endpoint host must resolve to public IP addresses");
  }

  return parsed.toString().replace(/\/$/, "");
}

/**
 * An undici dispatcher whose connector validates the *actual* resolved IP at
 * connection time. Because the check happens during connect — for the original
 * request and for any later connection the pool establishes — it closes the
 * DNS-rebinding window left open by the up-front {@link validatePublicHttpsBaseUrl}
 * check. Every resolved address is validated, but the full set is still handed
 * back to the connector so Node's dual-stack (Happy Eyeballs) selection keeps
 * working; this matters on IPv6-first hosts such as Railway, whose private
 * network uses ULA (`fd00::/8`) and CGNAT (`100.64.0.0/10`) ranges that are
 * already covered by {@link isPrivateAddress}.
 *
 * Use this only for user-supplied ("custom") endpoints; the operator-provided
 * default endpoint is trusted and may legitimately resolve to an internal host.
 */
export const ssrfSafeDispatcher = new Agent({
  connect: { lookup: ssrfSafeLookup }
});

function ssrfSafeLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
): void {
  // Resolve every candidate so the host can be rejected if *any* address is
  // non-public — this stops a mixed public/private result from slipping a
  // private address through dual-stack fallback.
  const lookupOptions = { ...options, all: true } as dns.LookupAllOptions;
  dns.lookup(hostname, lookupOptions, (err, addresses) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    if (addresses.length === 0) {
      callback(new Error(`Host ${hostname} did not resolve to any address`), "", 0);
      return;
    }
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
    if (blocked) {
      callback(
        new Error(
          `Refusing to connect to non-public address ${blocked.address} for host ${hostname}`
        ),
        "",
        0
      );
      return;
    }
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal"
  );
}

export function isPrivateAddress(address: string) {
  const mappedIpv4 = address.toLowerCase().startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : null;
  const ipVersion = net.isIP(mappedIpv4 ?? address);
  if (ipVersion === 4) return isPrivateIpv4(mappedIpv4 ?? address);
  if (ipVersion === 6) return isPrivateIpv6(address);
  return true;
}

export function isPrivateIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}
