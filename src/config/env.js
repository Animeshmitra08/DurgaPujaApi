import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";

dotenv.config();

/**
 * Hosting providers disagree about how a multi-line private key survives an
 * environment variable. Some keep the literal backslash-n we pasted, some
 * un-escape it into real newlines, and a few wrap the whole thing in quotes.
 * Normalise all three shapes into a real PEM block.
 */
const normalisePrivateKey = (raw) => {
  if (!raw) return "";
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n");
};

const toList = (raw) =>
  (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

/**
 * Pick a writable directory for multer's temporary files. Container
 * filesystems are often read-only outside of the OS temp dir, so we probe the
 * configured path and fall back rather than crashing on the first upload.
 */
const resolveTmpDir = (configured) => {
  const candidates = [
    path.resolve(process.cwd(), configured || "./uploads"),
    path.join(os.tmpdir(), "drive-storage-uploads"),
  ];

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    "No writable temporary upload directory available. Set UPLOAD_TMP_DIR."
  );
};

export const env = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",

  mongoUri: process.env.MONGODB_URI,

  corsOrigins: toList(process.env.CORS_ORIGIN) || [],

  google: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    privateKey: normalisePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    rootFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
    sharedDriveId: process.env.GOOGLE_SHARED_DRIVE_ID || null,
    impersonateUser: process.env.GOOGLE_IMPERSONATE_USER || null,
  },

  // Subfolder (under GOOGLE_DRIVE_FOLDER_ID) each fileType lands in when the
  // upload does not name one. Types not listed go to the root folder.
  typeFolders: {
    image: process.env.DRIVE_IMAGES_FOLDER || "images",
    audio: process.env.DRIVE_AUDIOS_FOLDER || "audios",
  },

  maxFileSizeBytes: (Number(process.env.MAX_FILE_SIZE_MB) || 200) * 1024 * 1024,
  uploadTmpDir: resolveTmpDir(process.env.UPLOAD_TMP_DIR),

  apiKey: process.env.API_KEY || null,
};

/**
 * Fail at boot rather than on the first request. A missing private key is a
 * deployment mistake, and it is much cheaper to find here.
 */
export const assertEnv = () => {
  const missing = [];
  if (!env.mongoUri) missing.push("MONGODB_URI");
  if (!env.google.clientEmail) missing.push("GOOGLE_CLIENT_EMAIL");
  if (!env.google.privateKey) missing.push("GOOGLE_PRIVATE_KEY");
  if (!env.google.rootFolderId) missing.push("GOOGLE_DRIVE_FOLDER_ID");

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  if (!env.google.privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "GOOGLE_PRIVATE_KEY does not look like a PEM block. Paste the full key " +
        "including the BEGIN/END lines, keeping \\n escapes if it is on one line."
    );
  }

  // A folder ID in GOOGLE_SHARED_DRIVE_ID makes every files.list call 404
  // with "Shared drive not found". Shared Drive IDs start with "0A".
  if (env.google.sharedDriveId && env.google.sharedDriveId === env.google.rootFolderId) {
    console.warn(
      "[warn] GOOGLE_SHARED_DRIVE_ID equals GOOGLE_DRIVE_FOLDER_ID. It must be " +
        "the Shared Drive's own ID (starts with 0A), not a folder ID; leave it " +
        "blank if the folder is in a regular My Drive."
    );
  }

  // Not fatal, but this is the single most common reason uploads fail.
  if (!env.google.sharedDriveId && !env.google.impersonateUser) {
    console.warn(
      "[warn] Neither GOOGLE_SHARED_DRIVE_ID nor GOOGLE_IMPERSONATE_USER is " +
        "set. Service accounts have no Drive storage quota, so uploads into a " +
        "personal Drive folder will fail with storageQuotaExceeded."
    );
  }

  if (env.isProduction && !env.apiKey) {
    console.warn(
      "[warn] API_KEY is not set: upload, update, replace and delete routes " +
        "are unauthenticated."
    );
  }

  if (env.isProduction && env.corsOrigins.includes("*")) {
    console.warn("[warn] CORS_ORIGIN is '*' in production.");
  }
};
