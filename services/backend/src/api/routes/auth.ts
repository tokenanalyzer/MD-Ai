import { Router } from "express";
import type pg from "pg";
import { autoPairBodySchema, pairBodySchema, pushTokenBodySchema, refreshBodySchema, revokeBodySchema } from "../schemas.js";
import { AppError } from "../errors.js";
import { authGuard } from "../middleware/authGuard.js";
import { consumePairingCode } from "../../core/security/pairing.js";
import { generateRefreshToken, hashRefreshToken, signAccessToken } from "../../core/security/jwt.js";
import { getOwner } from "../../db/repositories/ownerRepo.js";
import {
  createDeviceSession,
  findActiveSessionByRefreshHash,
  listActiveSessions,
  revokeSession,
  updatePushToken,
} from "../../db/repositories/deviceSessionRepo.js";

export function authRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post("/pair", async (req, res, next) => {
    try {
      const body = pairBodySchema.parse(req.body);
      const result = await consumePairingCode(pool, body.pairingCode);
      if (!result.ok) {
        throw new AppError(401, `pairing_${result.reason}`, "Pairing code is invalid, expired, or already used");
      }
      const owner = await getOwner(pool);
      if (!owner) throw new AppError(500, "no_owner", "No owner configured on this backend");

      const refreshToken = generateRefreshToken();
      const session = await createDeviceSession(pool, {
        ownerId: owner.id,
        deviceName: body.deviceName,
        platform: body.platform,
        refreshTokenHash: hashRefreshToken(refreshToken),
        pushToken: body.pushToken,
      });
      const { token, expiresIn } = signAccessToken({ sub: session.id, ownerId: owner.id });
      res.status(201).json({ data: { accessToken: token, refreshToken, expiresIn } });
    } catch (err) {
      next(err);
    }
  });

  // Owner's explicit choice: skip the pairing-code step entirely — the app
  // calls this on first launch (with no user-visible screen at all) instead
  // of showing the pairing form. This trades away the "prove you can read
  // this backend's own startup logs" gate: anyone who learns this backend's
  // URL can mint themselves a working session and spend this owner's
  // provider API keys, no code required. Acceptable only because this is a
  // single-owner private deployment the owner is choosing to run this way.
  router.post("/auto-pair", async (req, res, next) => {
    try {
      const body = autoPairBodySchema.parse(req.body);
      const owner = await getOwner(pool);
      if (!owner) throw new AppError(500, "no_owner", "No owner configured on this backend");

      const refreshToken = generateRefreshToken();
      const session = await createDeviceSession(pool, {
        ownerId: owner.id,
        deviceName: body.deviceName,
        platform: body.platform,
        refreshTokenHash: hashRefreshToken(refreshToken),
        pushToken: body.pushToken,
      });
      const { token, expiresIn } = signAccessToken({ sub: session.id, ownerId: owner.id });
      res.status(201).json({ data: { accessToken: token, refreshToken, expiresIn } });
    } catch (err) {
      next(err);
    }
  });

  router.post("/refresh", async (req, res, next) => {
    try {
      const body = refreshBodySchema.parse(req.body);
      const session = await findActiveSessionByRefreshHash(pool, hashRefreshToken(body.refreshToken));
      if (!session) throw AppError.unauthorized("Refresh token invalid or revoked");
      const { token, expiresIn } = signAccessToken({ sub: session.id, ownerId: session.owner_id });
      res.json({ data: { accessToken: token, expiresIn } });
    } catch (err) {
      next(err);
    }
  });

  router.post("/revoke", authGuard(pool), async (req, res, next) => {
    try {
      const body = revokeBodySchema.parse(req.body);
      await revokeSession(pool, body.deviceSessionId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // M5.13: push tokens rotate — the app re-registers on every cold start
  // (Expo/FCM tokens aren't permanent), so this is a distinct route from
  // /pair rather than requiring a fresh pairing to update one.
  router.post("/push-token", authGuard(pool), async (req, res, next) => {
    try {
      const body = pushTokenBodySchema.parse(req.body);
      await updatePushToken(pool, req.deviceSession!.id, body.pushToken);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get("/sessions", authGuard(pool), async (req, res, next) => {
    try {
      const sessions = await listActiveSessions(pool, req.deviceSession!.ownerId);
      res.json({
        data: sessions.map((s) => ({
          id: s.id,
          deviceName: s.device_name,
          platform: s.platform,
          lastSeenAt: s.last_seen_at?.toISOString(),
          createdAt: s.created_at.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
