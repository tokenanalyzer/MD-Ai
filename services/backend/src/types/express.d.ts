declare global {
  namespace Express {
    interface Request {
      deviceSession?: { id: string; ownerId: string };
      /** M10: the exact request bytes, captured by `express.json()`'s `verify` hook — needed by `POST /webhooks/automations/:slug` to compute the HMAC signature over what was actually sent, since `req.body` is already parsed/re-serializable-different JSON by the time a route handler sees it. */
      rawBody?: Buffer;
    }
  }
}

export {};
