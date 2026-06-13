// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  validatePublicHttpsBaseUrl
} from "@/lib/ssrf";

describe("isPrivateIpv4", () => {
  it("flags private, reserved and special-use ranges", () => {
    const privateAddresses = [
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "169.254.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "224.0.0.1",
      "255.255.255.255"
    ];
    for (const address of privateAddresses) {
      expect(isPrivateIpv4(address), address).toBe(true);
    }
  });

  it("allows public addresses just outside the blocked ranges", () => {
    const publicAddresses = [
      "8.8.8.8",
      "1.1.1.1",
      "11.0.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "126.255.255.255",
      "128.0.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.167.255.255",
      "192.169.0.1",
      "198.17.255.255",
      "198.20.0.1",
      "223.255.255.255"
    ];
    for (const address of publicAddresses) {
      expect(isPrivateIpv4(address), address).toBe(false);
    }
  });

  it("treats malformed IPv4 as private (fail-closed)", () => {
    for (const address of ["", "1.2.3", "1.2.3.4.5", "999.1.1.1", "10.0.0.-1", "a.b.c.d"]) {
      expect(isPrivateIpv4(address), address).toBe(true);
    }
  });
});

describe("isPrivateIpv6", () => {
  it("flags loopback, unspecified, ULA and link-local", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "FE80::1", "feb0::1"]) {
      expect(isPrivateIpv6(address), address).toBe(true);
    }
  });

  it("allows global unicast addresses", () => {
    for (const address of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(isPrivateIpv6(address), address).toBe(false);
    }
  });
});

describe("isPrivateAddress", () => {
  it("classifies IPv4, IPv6 and IPv4-mapped IPv6 addresses", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    // IPv4-mapped IPv6 must be unwrapped before classification.
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::FFFF:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("treats anything that is not a valid IP as private (fail-closed)", () => {
    for (const value of ["", "not-an-ip", "example.com"]) {
      expect(isPrivateAddress(value), value).toBe(true);
    }
  });
});

describe("validatePublicHttpsBaseUrl", () => {
  it("rejects non-URLs", async () => {
    await expect(validatePublicHttpsBaseUrl("not a url")).rejects.toThrow(
      "Endpoint must be a valid URL"
    );
  });

  it("requires https", async () => {
    await expect(validatePublicHttpsBaseUrl("http://example.com")).rejects.toThrow(
      "Endpoint must use https"
    );
  });

  it("rejects embedded credentials", async () => {
    await expect(validatePublicHttpsBaseUrl("https://user:pass@example.com")).rejects.toThrow(
      "Endpoint must not include credentials"
    );
  });

  it("rejects query strings and fragments", async () => {
    await expect(validatePublicHttpsBaseUrl("https://example.com/v1?key=1")).rejects.toThrow(
      "Endpoint must not include query parameters or fragments"
    );
    await expect(validatePublicHttpsBaseUrl("https://example.com/v1#frag")).rejects.toThrow(
      "Endpoint must not include query parameters or fragments"
    );
  });

  it("rejects blocked hostnames before any DNS lookup", async () => {
    for (const url of [
      "https://localhost",
      "https://api.localhost",
      "https://metadata.google.internal"
    ]) {
      await expect(validatePublicHttpsBaseUrl(url), url).rejects.toThrow(
        "Endpoint host is not allowed"
      );
    }
  });

  it("rejects hosts that resolve to private IPs (IP literals short-circuit DNS)", async () => {
    for (const url of ["https://10.0.0.1", "https://127.0.0.1", "https://169.254.169.254"]) {
      await expect(validatePublicHttpsBaseUrl(url), url).rejects.toThrow(
        "Endpoint host must resolve to public IP addresses"
      );
    }
  });

  it("accepts a public endpoint and strips the trailing slash", async () => {
    await expect(validatePublicHttpsBaseUrl("https://8.8.8.8/v1/")).resolves.toBe(
      "https://8.8.8.8/v1"
    );
    await expect(validatePublicHttpsBaseUrl("https://8.8.8.8")).resolves.toBe("https://8.8.8.8");
  });
});
