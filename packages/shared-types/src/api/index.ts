/**
 * Common REST/WS envelope shapes shared between the backend API layer and
 * the mobile app's generated client. Endpoint-specific request/response
 * types live alongside their domain (agents/, a2a/, memory/, ...); this
 * file only holds the wrapper shapes every endpoint uses.
 */

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ApiSuccess<T> {
  data: T;
}

export interface ApiFailure {
  error: ApiError;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  nextCursor?: string;
}

export interface DeviceSession {
  id: string;
  deviceName: string;
  platform: "android" | "pc" | "other";
  lastSeenAt?: string;
  createdAt: string;
  revokedAt?: string;
}
