import type { NextFunction, Request, Response } from "express";
import type pg from "pg";
import { InvalidTokenError, verifyAccessToken } from "../../core/security/jwt.js";
import { findActiveSessionById, touchLastSeen } from "../../db/repositories/deviceSessionRepo.js";
import { AppError } from "../errors.js";

/** Every route except /auth/* requires a valid, unrevoked device session bearer token (docs/architecture/07-security-model.md §2). */
export function authGuard(pool: pg.Pool) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      next(AppError.unauthorized("Missing bearer token"));
      return;
    }
    try {
      const claims = verifyAccessToken(header.slice("Bearer ".length));
      const session = await findActiveSessionById(pool, claims.sub);
      if (!session) {
        next(AppError.unauthorized("Session revoked or not found"));
        return;
      }
      req.deviceSession = { id: session.id, ownerId: session.owner_id };
      void touchLastSeen(pool, session.id);
      next();
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        next(AppError.unauthorized("Invalid or expired token"));
        return;
      }
      next(err);
    }
  };
}
