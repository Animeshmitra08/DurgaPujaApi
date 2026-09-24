import fs from "fs/promises";

export const FILE_TYPES = ["audio", "image", "video", "pdf", "document", "other"];

/**
 * MIME types we accept. An allowlist rather than a blocklist: unknown types
 * are rejected instead of quietly stored, which keeps executables and HTML out
 * of a store that is later streamed back to browsers.
 */
export const ALLOWED_MIME_TYPES = new Set([
  // audio
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/x-m4a",

  // image
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/svg+xml",

  // video
  "video/mp4",
  "video/mpeg",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",

  // pdf
  "application/pdf",

  // documents
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/rtf",
  "text/plain",
  "text/csv",

  // archives
  "application/zip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",

  // fallback for clients that send no type
  "application/octet-stream",
]);

const DOCUMENT_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/rtf",
  "text/plain",
  "text/csv",
]);

/** audio/mpeg -> audio, application/pdf -> pdf, and so on. */
export const detectFileType = (mimeType = "") => {
  const mime = mimeType.toLowerCase();

  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (DOCUMENT_MIME_TYPES.has(mime)) return "document";

  return "other";
};

export const isAllowedMimeType = (mimeType = "") =>
  ALLOWED_MIME_TYPES.has(mimeType.toLowerCase());

/**
 * Magic-byte signatures for the formats worth verifying. The browser-supplied
 * Content-Type on a multipart part is attacker controlled, so for the types we
 * later stream back inline we confirm the bytes agree with the label.
 */
const SIGNATURES = [
  { mime: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  {
    mime: "image/png",
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  // RIFF....WEBP / WAVE and ftyp-based MP4 family are checked below.
];

const startsWith = (buffer, bytes, offset = 0) =>
  bytes.every((byte, index) => buffer[offset + index] === byte);

/**
 * Read the first bytes of the temp file and derive a MIME type from content.
 * Returns null when the format has no signature we check (documents, most
 * audio), in which case the declared type stands.
 */
export const sniffMimeType = async (filePath) => {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, 32, 0);
    if (bytesRead < 4) return null;

    for (const sig of SIGNATURES) {
      if (startsWith(buffer, sig.bytes, sig.offset)) return sig.mime;
    }

    // RIFF container: bytes 8-11 disambiguate WEBP from WAVE.
    if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46])) {
      const tag = buffer.slice(8, 12).toString("ascii");
      if (tag === "WEBP") return "image/webp";
      if (tag === "WAVE") return "audio/wav";
    }

    // ISO base media (mp4, m4a, mov): 'ftyp' at offset 4.
    if (startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
      const brand = buffer.slice(8, 12).toString("ascii");
      if (brand.startsWith("qt")) return "video/quicktime";
      if (brand.startsWith("M4A")) return "audio/mp4";
      return "video/mp4";
    }

    // HTML masquerading as something else is the payload we most want to catch.
    const head = buffer.slice(0, 32).toString("ascii").trim().toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
      return "text/html";
    }

    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

/**
 * Content types that must never render inline on our own origin. Serving these
 * with Content-Disposition: inline would execute attacker script under the
 * API's origin.
 */
const FORCE_DOWNLOAD_MIME_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "text/xml",
  "application/xml",
  "application/xhtml+xml",
]);

export const shouldForceDownload = (mimeType = "") =>
  FORCE_DOWNLOAD_MIME_TYPES.has(mimeType.toLowerCase());

/** Only media and PDFs are worth rendering in place. */
export const isInlineRenderable = (mimeType = "") => {
  const mime = mimeType.toLowerCase();
  if (shouldForceDownload(mime)) return false;
  return (
    mime.startsWith("audio/") ||
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime === "application/pdf"
  );
};
