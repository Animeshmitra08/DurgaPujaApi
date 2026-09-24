import fs from "fs";
import {
  drive,
  sharedDriveParams,
  sharedDriveWriteParams,
  ROOT_FOLDER_ID,
} from "../config/googleDrive.js";
import { ApiError } from "../utils/ApiError.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id, name, mimeType, size, createdTime, parents";

/* -------------------------------------------------------------------------- */
/* Error translation                                                           */
/* -------------------------------------------------------------------------- */

const reasonOf = (err) =>
  err?.errors?.[0]?.reason ||
  err?.response?.data?.error?.errors?.[0]?.reason ||
  err?.code;

/**
 * Drive's own status codes are not safe to forward verbatim: a 404 from Drive
 * means our stored driveFileId is stale (a server-side integrity problem),
 * not that the caller asked for a missing resource.
 */
const translateDriveError = (err, context) => {
  const status = err?.code || err?.response?.status;
  const reason = reasonOf(err);

  if (reason === "storageQuotaExceeded") {
    return ApiError.badGateway(
      "Google Drive rejected the upload: the account has no available storage " +
        "quota. Service accounts have no quota of their own - upload to a " +
        "Shared Drive (GOOGLE_SHARED_DRIVE_ID) or use domain-wide delegation " +
        "(GOOGLE_IMPERSONATE_USER).",
      { reason, context }
    );
  }

  if (status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded")) {
    return new ApiError(
      503,
      "Google Drive rate limit exceeded. Please retry shortly.",
      { reason, context }
    );
  }

  if (status === 403 && reason === "cannotDownloadAbusiveFile") {
    return new ApiError(
      403,
      "Google Drive has flagged this file as potentially abusive.",
      { reason, context }
    );
  }

  if (status === 401 || status === 403) {
    return ApiError.badGateway(
      "Google Drive denied the request. Check that the service account has " +
        "access to the target folder.",
      { reason, context }
    );
  }

  if (status === 404) {
    return ApiError.badGateway(
      "The requested file no longer exists in Google Drive.",
      { reason, context, notFoundInDrive: true }
    );
  }

  return ApiError.badGateway(
    `Google Drive request failed (${context}): ${err?.message || "unknown error"}`,
    { reason, context }
  );
};

export const isDriveNotFound = (err) => {
  const status = err?.code || err?.response?.status;
  return status === 404 || err?.details?.notFoundInDrive === true;
};

/* -------------------------------------------------------------------------- */
/* Retry                                                                       */
/* -------------------------------------------------------------------------- */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "backendError",
  "internalError",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive answers bursts with 403 rateLimitExceeded and occasional 5xx. Google's
 * documented remedy is exponential backoff with jitter.
 *
 * Only for idempotent-enough operations: an upload that already reached Drive
 * before the socket died would be duplicated by a retry, so uploads pass
 * retries: 0 and are handled by the caller.
 */
const withRetry = async (operation, { retries = 4, context = "drive" } = {}) => {
  let attempt = 0;

  for (;;) {
    try {
      return await operation();
    } catch (err) {
      const status = err?.code || err?.response?.status;
      const retryable =
        RETRYABLE_STATUS.has(status) || RETRYABLE_REASONS.has(reasonOf(err));

      if (!retryable || attempt >= retries) {
        throw translateDriveError(err, context);
      }

      const delay = Math.min(2 ** attempt * 500, 8000) + Math.random() * 300;
      console.warn(
        `[drive] ${context} failed (${status}); retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms`
      );
      await sleep(delay);
      attempt += 1;
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Upload a local file into Drive.
 *
 * @param {object}  params
 * @param {string}  params.filePath  path to the temporary local file
 * @param {string}  params.fileName  name to give the object in Drive
 * @param {string}  params.mimeType
 * @param {string} [params.folderId] defaults to GOOGLE_DRIVE_FOLDER_ID
 * @returns {Promise<{id: string, name: string, mimeType: string, size: number, folderId: string}>}
 */
export const uploadFile = async ({ filePath, fileName, mimeType, folderId }) => {
  const parentId = folderId || ROOT_FOLDER_ID;

  try {
    const response = await drive.files.create({
      ...sharedDriveWriteParams,
      requestBody: {
        name: fileName,
        parents: [parentId],
        mimeType,
      },
      media: {
        mimeType,
        body: fs.createReadStream(filePath),
      },
      fields: FILE_FIELDS,
    });

    const data = response.data;
    return {
      id: data.id,
      name: data.name,
      mimeType: data.mimeType,
      size: Number(data.size) || 0,
      folderId: parentId,
    };
  } catch (err) {
    throw translateDriveError(err, "uploadFile");
  }
};

/** Metadata straight from Drive. Rarely needed - MongoDB is the source of truth. */
export const getFileMetadata = async (fileId) =>
  withRetry(
    async () => {
      const response = await drive.files.get({
        fileId,
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      return {
        id: response.data.id,
        name: response.data.name,
        mimeType: response.data.mimeType,
        size: Number(response.data.size) || 0,
      };
    },
    { context: "getFileMetadata" }
  );

/**
 * Open a read stream for a Drive file, forwarding an HTTP Range header when the
 * client sent one.
 *
 * Range passthrough is what makes <video> and <audio> seekable, and it is what
 * Safari requires before it will play media at all.
 *
 * @returns {Promise<{stream: import("stream").Readable, status: number, headers: object}>}
 */
export const getFileStream = async (fileId, { range } = {}) =>
  withRetry(
    async () => {
      const response = await drive.files.get(
        {
          fileId,
          alt: "media",
          supportsAllDrives: true,
          // Drive refuses to serve files it has flagged unless we opt in.
          acknowledgeAbuse: true,
        },
        {
          responseType: "stream",
          // identity: a gzipped body would be inflated by fetch, and the
          // bytes sent would no longer match the Content-Length we declare.
          headers: {
            "Accept-Encoding": "identity",
            ...(range ? { Range: range } : {}),
          },
        }
      );

      // gaxios 7 (googleapis 150+) returns a fetch `Headers` object, where
      // indexing by name is always undefined; older versions return a plain
      // object. Without these two headers browsers refuse to play the 206s
      // that <audio> asks for, and cannot work out a track's duration.
      const header = (name) =>
        typeof response.headers?.get === "function"
          ? response.headers.get(name) ?? undefined
          : response.headers?.[name];

      return {
        stream: response.data,
        status: response.status === 206 ? 206 : 200,
        headers: {
          contentLength: header("content-length"),
          contentRange: header("content-range"),
          contentType: header("content-type"),
        },
      };
    },
    { context: "getFileStream" }
  );

/**
 * Remove a file from Drive.
 *
 * @param {string}  fileId
 * @param {object} [options]
 * @param {boolean} [options.trash=false] move to trash instead of deleting
 *   outright. Trashing is recoverable for 30 days; files.delete is immediate
 *   and permanent.
 */
export const deleteFile = async (fileId, { trash = false } = {}) =>
  withRetry(
    async () => {
      if (trash) {
        await drive.files.update({
          fileId,
          requestBody: { trashed: true },
          ...sharedDriveWriteParams,
        });
      } else {
        await drive.files.delete({ fileId, ...sharedDriveWriteParams });
      }
      return true;
    },
    { context: "deleteFile" }
  );

/**
 * Best-effort delete used to compensate for a failed database write. Never
 * throws: the caller is already handling a different error and must not have
 * it masked. A failure here leaves an orphan, so it is logged loudly for
 * reconciliation.
 */
export const deleteFileQuietly = async (fileId) => {
  if (!fileId) return false;
  try {
    await deleteFile(fileId);
    return true;
  } catch (err) {
    if (isDriveNotFound(err)) return true;
    console.error(
      `[drive][ORPHAN] failed to clean up Drive file ${fileId}: ${err.message}. ` +
        "This file is now unreferenced and must be removed manually."
    );
    return false;
  }
};

/** List files inside a folder. Diagnostics and reconciliation, not the read path. */
export const listFiles = async ({
  folderId,
  pageSize = 100,
  pageToken,
} = {}) =>
  withRetry(
    async () => {
      const parentId = folderId || ROOT_FOLDER_ID;
      const response = await drive.files.list({
        q: `'${parentId}' in parents and trashed = false`,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: Math.min(pageSize, 1000),
        pageToken,
        ...sharedDriveParams,
      });

      return {
        files: (response.data.files || []).map((file) => ({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: Number(file.size) || 0,
          createdTime: file.createdTime,
        })),
        nextPageToken: response.data.nextPageToken || null,
      };
    },
    { context: "listFiles" }
  );

export const isFolderMimeType = (mimeType) => mimeType === FOLDER_MIME_TYPE;

/** Look up a subfolder by name under a parent. Returns its ID or null; never creates. */
export const findFolder = async (name, parentId = ROOT_FOLDER_ID) =>
  withRetry(
    async () => {
      const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const existing = await drive.files.list({
        q:
          `name = '${escaped}' and '${parentId}' in parents ` +
          `and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
        fields: "files(id, name)",
        pageSize: 1,
        ...sharedDriveParams,
      });

      return existing.data.files?.[0]?.id || null;
    },
    { context: "findFolder" }
  );

/**
 * Find or create a subfolder by name under a parent.
 *
 * Exists so the flat ApplicationStorage layout can grow into per-type folders
 * (Audio/, Images/, ...) without any folder ID being hardcoded: callers pass a
 * name and get an ID back.
 */
export const ensureFolder = async (name, parentId = ROOT_FOLDER_ID) => {
  const existingId = await findFolder(name, parentId);
  if (existingId) return existingId;

  return withRetry(
    async () => {
      const created = await drive.files.create({
        requestBody: {
          name,
          mimeType: FOLDER_MIME_TYPE,
          parents: [parentId],
        },
        fields: "id",
        ...sharedDriveWriteParams,
      });

      return created.data.id;
    },
    { context: "ensureFolder" }
  );
};

/** Cheap startup probe: confirms credentials and folder access are real. */
export const verifyAccess = async () => {
  const response = await withRetry(
    () =>
      drive.files.get({
        fileId: ROOT_FOLDER_ID,
        fields: "id, name, mimeType",
        supportsAllDrives: true,
      }),
    { context: "verifyAccess", retries: 1 }
  );

  if (response.data.mimeType !== FOLDER_MIME_TYPE) {
    throw new Error("GOOGLE_DRIVE_FOLDER_ID does not point to a folder.");
  }

  return { id: response.data.id, name: response.data.name };
};
