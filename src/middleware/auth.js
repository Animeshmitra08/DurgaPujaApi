import crypto from "crypto";
import { env } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";

/** Constant-time compare so the key cannot be recovered by timing. */
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Guards the write routes. Inert unless API_KEY is set, so local testing needs
 * no setup - but without it anyone who can reach the service can upload and
 * delete, so set it before exposing this publicly.
 *
 * A shared key is the floor, not the ceiling. Swap in JWT or session auth here
 * when the API gains real users.
 */
export const requireApiKey = (req, _res, next) => {
  if (!env.apiKey) return next();

  const provided =
    req.get("x-api-key") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (!provided || !safeEqual(provided, env.apiKey)) {
    return next(ApiError.unauthorized("Valid API key required."));
  }

  next();
};
