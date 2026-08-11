import "../setupEnv.js";
import { describe, expect, it } from "vitest";
import { generateRefreshToken, hashRefreshToken, InvalidTokenError, signAccessToken, verifyAccessToken } from "../../src/core/security/jwt.js";

describe("jwt", () => {
  it("signs and verifies a valid access token round-trip", () => {
    const { token, expiresIn } = signAccessToken({ sub: "session-1", ownerId: "owner-1" });
    expect(expiresIn).toBe(15 * 60);
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe("session-1");
    expect(claims.ownerId).toBe("owner-1");
  });

  it("rejects a tampered token", () => {
    const { token } = signAccessToken({ sub: "session-1", ownerId: "owner-1" });
    const tampered = `${token.slice(0, -2)}xx`;
    expect(() => verifyAccessToken(tampered)).toThrow(InvalidTokenError);
  });

  it("rejects a garbage token", () => {
    expect(() => verifyAccessToken("not-a-jwt")).toThrow(InvalidTokenError);
  });

  it("hashes refresh tokens deterministically without exposing the original", () => {
    const token = generateRefreshToken();
    const hash1 = hashRefreshToken(token);
    const hash2 = hashRefreshToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toContain(token);
    expect(token.length).toBeGreaterThan(20);
  });
});
