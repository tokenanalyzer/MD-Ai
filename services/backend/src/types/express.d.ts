declare global {
  namespace Express {
    interface Request {
      deviceSession?: { id: string; ownerId: string };
    }
  }
}

export {};
