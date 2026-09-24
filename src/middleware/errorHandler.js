import multer from "multer";
import { env } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { removeTempFile } from "../utils/tempFiles.js";

export const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  // A request can fail after multer wrote the temp file but before the
  // controller's own cleanup ran. Without this the disk fills up slowly.
  if (req.file?.path) {
    removeTempFile(req.file.path);
  }

  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal server error";
  let details = err.details;

  if (err instanceof multer.MulterError) {
    statusCode = 400;
    if (err.code === "LIMIT_FILE_SIZE") {
      statusCode = 413;
      message = `File exceeds the ${Math.round(
        env.maxFileSizeBytes / (1024 * 1024)
      )}MB limit.`;
    } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
      message = `Unexpected file field '${err.field}'. Use the field name 'file'.`;
    } else {
      message = `Upload error: ${err.message}`;
    }
  } else if (err.code === "UNSUPPORTED_MIME_TYPE") {
    statusCode = 415;
  } else if (err.name === "ValidationError") {
    statusCode = 400;
    details = Object.values(err.errors || {}).map((e) => e.message);
    message = "Validation failed";
  } else if (err.name === "CastError") {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  } else if (err.code === 11000) {
    statusCode = 409;
    message = "A record with that value already exists.";
  }

  if (statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  // Internal failures get a generic message in production; the stack and the
  // real reason stay in the logs rather than going to the client.
  const body = {
    success: false,
    message:
      statusCode >= 500 && env.isProduction
        ? "Internal server error"
        : message,
  };

  if (details && !(statusCode >= 500 && env.isProduction)) {
    body.details = details;
  }
  if (!env.isProduction && err.stack) {
    body.stack = err.stack;
  }

  res.status(statusCode).json(body);
};
