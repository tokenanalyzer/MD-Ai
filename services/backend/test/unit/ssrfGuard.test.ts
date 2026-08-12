import { describe, expect, it } from "vitest";
import { assertSafeUrl, UnsafeUrlError } from "../../src/core/security/ssrfGuard.js";

describe("SSRF guard (M4.5/M4.8/M4.15)", () => {
  it("rejects non-https URLs", async () => {
    await expect(assertSafeUrl("http://example.com")).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrl("ftp://example.com")).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects malformed/invalid URLs", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrl("")).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrl("https://")).rejects.toThrow(UnsafeUrlError);
  });

  it("blocks localhost by name, with or without a port", async () => {
    await expect(assertSafeUrl("https://localhost")).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrl("https://localhost:8080/admin")).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrl("https://LOCALHOST")).rejects.toThrow(UnsafeUrlError); // case-insensitive
  });

  it("blocks loopback and private IPv4 literals", async () => {
    for (const url of [
      "https://127.0.0.1",
      "https://127.0.0.1:9200",
      "https://10.0.0.5",
      "https://172.16.0.1",
      "https://172.31.255.255",
      "https://192.168.1.1",
      "https://0.0.0.0",
    ]) {
      await expect(assertSafeUrl(url)).rejects.toThrow(UnsafeUrlError);
    }
  });

  it("blocks the cloud metadata endpoint (169.254.169.254) shared by AWS/GCP/Azure/OCI", async () => {
    await expect(assertSafeUrl("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(UnsafeUrlError);
  });

  it("blocks known cloud metadata hostnames outright", async () => {
    await expect(assertSafeUrl("https://metadata.google.internal/computeMetadata/v1/")).rejects.toThrow(UnsafeUrlError);
  });

  it("blocks loopback and unique-local IPv6 literals", async () => {
    await expect(assertSafeUrl("https://[::1]")).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrl("https://[fd00::1]")).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeUrl("https://[fe80::1]")).rejects.toThrow(UnsafeUrlError);
  });

  it("allows a legitimate public HTTPS hostname (real DNS resolution, no network call)", async () => {
    const url = await assertSafeUrl("https://example.com/path");
    expect(url.hostname).toBe("example.com");
  });

  it("rejects a public-looking IPv4-mapped IPv6 literal that's actually private", async () => {
    await expect(assertSafeUrl("https://[::ffff:127.0.0.1]")).rejects.toThrow(UnsafeUrlError);
  });
});
