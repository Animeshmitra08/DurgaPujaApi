import crypto from "crypto";
import multer from "multer";
import path from "path";
import { env } from "../config/env.js";
import { isAllowedMimeType } from "../utils/fileType.js";
import { sanitizeFileName } from "../utils/sanitize.js";

/**
 * Temporary disk storage. The file exists on this server only for the seconds
 * between the request finishing and the Drive upload completing, then it is
 * removed. Nothing here survives a deploy, and nothing is meant to.
 *
 * Memory storage would avoid the disk entirely but buffers the whole file in
 * RAM, which a 200MB video would not survive on a small instance.
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, env.uploadTmpDir),
  filename: (_req, file, cb) => {
    // The temp name is random and never derived from client input: the client
    // never chooses a path on our filesystem.
    const ext = path.extname(sanitizeFileName(file.originalname)).slice(0, 12);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

/**
 * First-pass MIME check on the declared type. This rejects obvious junk before
 * a single byte hits the disk; the controller re-checks against sniffed magic
 * bytes once the file has landed, because this header is client-controlled.
 *
 * Note that req.body is unreliable here - multer populates text fields in the
 * order they appear in the multipart body, so a field sent after the file is
 * not visible yet. All body-dependent logic lives in the controller.
 */
const fileFilter = (_req, file, cb) => {
  if (!isAllowedMimeType(file.mimetype)) {
    const err = new Error(`Unsupported file type: ${file.mimetype}`);
    err.code = "UNSUPPORTED_MIME_TYPE";
    return cb(err);
  }
  cb(null, true);
};

const uploader = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: env.maxFileSizeBytes,
    files: 1,
    fields: 20,
    fieldSize: 100 * 1024,
  },
});

/** Single-file upload under the field name `file`. */
export const uploadSingle = uploader.single("file");
