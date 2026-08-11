import { randomBytes, createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { loadEnv } from "../../config/env.js";

export interface AccessTokenClaims {
  sub: string; // device_sessions.id
  ownerId: string;
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export function signAccessToken(claims: AccessTokenClaims): { token: string; expiresIn: number } {
  const env = loadEnv();
  const token = jwt.sign(claims, env.MDAI_JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const env = loadEnv();
  try {
    const decoded = jwt.verify(token, env.MDAI_JWT_SECRET);
    if (typeof decoded === "string" || !decoded.sub || !decoded["ownerId"]) {
      throw new InvalidTokenError("Malformed token payload");
    }
    return { sub: decoded.sub, ownerId: decoded["ownerId"] as string };
  } catch (err) {
    if (err instanceof InvalidTokenError) throw err;
    throw new InvalidTokenError((err as Error).message);
  }
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
