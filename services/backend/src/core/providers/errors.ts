export class ProviderCallError extends Error {
  readonly providerId: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(providerId: string, message: string, opts: { status?: number; retryable: boolean }) {
    super(message);
    this.name = "ProviderCallError";
    this.providerId = providerId;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

/** HTTP statuses worth a bounded retry / fallback attempt; everything else (4xx auth/validation) is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
