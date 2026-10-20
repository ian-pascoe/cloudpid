import { describe, expect, it } from "vitest";
import { blockedAddressReason, blockedHostReason } from "./ssrf.ts";

/** The host of `url` as the fetch guard sees it: after the WHATWG URL parser has normalised it. */
const host = (url: string): string => new URL(url).hostname;

const blockedUrls = [
  // Loopback, in every encoding the URL parser accepts.
  "http://127.0.0.1/",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://0177.0.0.1/",
  "http://[::1]/",
  "http://[0:0:0:0:0:0:0:1]/",
  "http://localhost/",
  "http://LOCALHOST./",
  "http://foo.localhost/",
  // Private and shared ranges.
  "http://10.0.0.1/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.1.1/",
  "http://100.64.0.1/",
  "http://100.127.255.255/",
  "http://0.0.0.0/",
  "http://198.18.0.1/",
  // Link-local, and the cloud metadata services.
  "http://169.254.169.254/",
  "http://[fd00:ec2::254]/",
  "http://[fe80::1]/",
  "http://metadata.google.internal/",
  "http://metadata.google.internal./",
  "http://instance-data.ec2.internal/",
  "http://metadata/",
  "http://100.100.100.200/",
  // Unique-local, multicast, and unspecified IPv6.
  "http://[fc00::1]/",
  "http://[fdff::1]/",
  "http://[ff02::1]/",
  "http://[::]/",
  // IPv4 inside IPv6.
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/",
  "http://[::ffff:a9fe:a9fe]/",
  "http://[::127.0.0.1]/",
  "http://[64:ff9b::7f00:1]/",
  "http://[2002:7f00:1::]/",
  // Names that are not public hostnames.
  "http://intranet/",
  "http://printer.local/",
  "http://nas.home.arpa/",
  // Reserved and multicast IPv4.
  "http://224.0.0.1/",
  "http://255.255.255.255/",
  "http://192.0.2.1/",
];

const allowedUrls = [
  "https://example.com/",
  "https://example.com./",
  "http://93.184.216.34/",
  "http://1.1.1.1/",
  "http://8.8.8.8/",
  "http://172.15.0.1/",
  "http://172.32.0.1/",
  "http://100.63.255.255/",
  "http://100.128.0.1/",
  "http://[2606:4700:4700::1111]/",
  "http://[::ffff:8.8.8.8]/",
  "http://[2001:4860:4860::8888]/",
  "https://sub.domain.example.org/path?q=1",
];

describe("blockedHostReason", () => {
  it.each(blockedUrls)("refuses %s", (url) => {
    expect(blockedHostReason(host(url))).toEqual(expect.any(String));
  });

  it.each(allowedUrls)("allows %s", (url) => {
    expect(blockedHostReason(host(url))).toBeUndefined();
  });

  it.each(["2130706433", "0x7f.1", "0177.0.0.01", "127.0.0.1.", "0300.0250.0.1"])(
    "decodes the numeric host %s as a resolver would, and refuses it",
    (name) => {
      expect(blockedHostReason(name)).toEqual(expect.any(String));
    },
  );

  it("decodes a short numeric host to the public address it names", () => {
    // inet_aton reads 8.8.2056 as 8.8.8.8.
    expect(blockedHostReason("8.8.2056")).toBeUndefined();
  });

  it("refuses an IPv6 zone identifier", () => {
    expect(blockedHostReason("[fe80::1%25eth0]")).toEqual(expect.any(String));
  });

  it("refuses an empty host", () => {
    expect(blockedHostReason("")).toEqual(expect.any(String));
  });
});

describe("blockedAddressReason", () => {
  it.each(["10.1.2.3", "::1", "fd12:3456::1", "169.254.169.254", "::ffff:10.0.0.1"])(
    "refuses the resolved address %s",
    (address) => {
      expect(blockedAddressReason(address)).toEqual(expect.any(String));
    },
  );

  it.each(["93.184.216.34", "2606:4700:4700::1111"])(
    "allows the resolved address %s",
    (address) => {
      expect(blockedAddressReason(address)).toBeUndefined();
    },
  );

  it("refuses text that is not an address", () => {
    expect(blockedAddressReason("not-an-ip")).toEqual(expect.any(String));
  });
});
