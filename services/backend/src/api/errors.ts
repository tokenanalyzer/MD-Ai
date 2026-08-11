export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }

  static badRequest(message: string, code = "bad_request"): AppError {
    return new AppError(400, code, message);
  }
  static unauthorized(message = "Unauthorized", code = "unauthorized"): AppError {
    return new AppError(401, code, message);
  }
  static notFound(message = "Not found", code = "not_found"): AppError {
    return new AppError(404, code, message);
  }
}
