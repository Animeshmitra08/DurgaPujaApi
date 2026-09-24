export class ApiError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, ApiError);
  }

  static badRequest(message, details) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = "Unauthorized") {
    return new ApiError(401, message);
  }

  static notFound(message = "Resource not found") {
    return new ApiError(404, message);
  }

  static payloadTooLarge(message) {
    return new ApiError(413, message);
  }

  static unsupportedMedia(message, details) {
    return new ApiError(415, message, details);
  }

  static badGateway(message, details) {
    return new ApiError(502, message, details);
  }
}

/** Wraps an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
