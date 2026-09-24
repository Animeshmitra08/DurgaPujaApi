import mongoose from "mongoose";
import { env } from "../config/env.js";
import { File } from "../models/File.js";
import { storage } from "../services/storageService.js";
import { ApiError, asyncHandler } from "../utils/ApiError.js";
import {
  FILE_TYPES,
  detectFileType,
  isAllowedMimeType,
  isInlineRenderable,
  shouldForceDownload,
  sniffMimeType,
} from "../utils/fileType.js";
import { parseRange } from "../utils/httpRange.js";
import {
  buildStoredFileName,
  cleanText,
  contentDisposition,
  sanitizeFileName,
} from "../utils/sanitize.js";
import { removeTempFile } from "../utils/tempFiles.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const assertValidObjectId = (id) => {
  if (!mongoose.isValidObjectId(id)) {
    throw ApiError.badRequest(`Invalid file id: ${id}`);
  }
};

/**
 * Decide the MIME type to trust.
 *
 * The multipart Content-Type is chosen by the client, so for any format with a
 * recognisable signature the bytes win. An HTML payload dressed up as an image
 * is rejected outright rather than stored - otherwise the stream endpoint
 * would later hand attacker-authored markup back on our own origin.
 */
const resolveMimeType = async (tempPath, declaredMime) => {
  const sniffed = await sniffMimeType(tempPath);

  if (sniffed === "text/html") {
    throw ApiError.unsupportedMedia(
      "File content is HTML, which is not accepted by this API."
    );
  }

  const resolved = sniffed || declaredMime;

  if (!isAllowedMimeType(resolved)) {
    throw ApiError.unsupportedMedia(
      `Unsupported file type: ${resolved}`,
      sniffed && sniffed !== declaredMime
        ? { declared: declaredMime, detected: sniffed }
        : undefined
    );
  }

  return resolved;
};

/** Requested fileType wins when it is a legal value, otherwise derive it. */
const resolveFileType = (requested, mimeType) => {
  const candidate = cleanText(requested, 20)?.toLowerCase();
  if (candidate && FILE_TYPES.includes(candidate)) return candidate;
  return detectFileType(mimeType);
};

/**
 * Resolve the destination folder.
 *
 * The client may pass a folder *name*, never a Drive folder ID: accepting raw
 * IDs would let a caller write into any folder the service account can reach.
 * Names are resolved (and created if needed) beneath the configured root, so
 * the ApplicationStorage/Audio, /Images, ... layout can be adopted later
 * without hardcoding a single ID.
 */
const cleanFolderName = (folderName) => {
  const name = cleanText(folderName, 100);
  if (!name) return undefined;

  if (!/^[\w \-.]{1,100}$/.test(name)) {
    throw ApiError.badRequest(
      "folderName may only contain letters, numbers, spaces, dots, hyphens and underscores."
    );
  }

  return name;
};

/**
 * An explicit folderName wins; otherwise the file goes to its type's folder
 * (images/, audios/), and anything else to GOOGLE_DRIVE_FOLDER_ID.
 */
const resolveFolderId = async (folderName, fileType) => {
  const name = cleanFolderName(folderName) || env.typeFolders[fileType];
  if (!name) return undefined; // service falls back to GOOGLE_DRIVE_FOLDER_ID

  return storage.ensureFolder(name);
};

/**
 * Push a local temp file to storage and record it in MongoDB.
 *
 * The ordering matters: the object must exist in Drive before we can store its
 * ID, but that leaves a window where Drive holds a file MongoDB knows nothing
 * about. If the insert fails we delete what we just uploaded, so a failed
 * request leaves no orphan.
 */
const persistUpload = async ({ tempFile, body }) => {
  const mimeType = await resolveMimeType(tempFile.path, tempFile.mimetype);
  const fileType = resolveFileType(body.fileType, mimeType);
  const folderId = await resolveFolderId(body.folderName, fileType);

  const originalName = sanitizeFileName(tempFile.originalname);
  const storedName = buildStoredFileName(tempFile.originalname);

  const uploaded = await storage.uploadFile({
    filePath: tempFile.path,
    fileName: storedName,
    mimeType,
    folderId,
  });

  return {
    uploaded,
    metadata: {
      originalName,
      fileName: uploaded.name || storedName,
      mimeType,
      fileSize: uploaded.size || tempFile.size,
      fileType,
      driveFileId: uploaded.id,
      driveFolderId: uploaded.folderId,
    },
  };
};

/* -------------------------------------------------------------------------- */
/* POST /api/files/upload                                                      */
/* -------------------------------------------------------------------------- */

export const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw ApiError.badRequest(
      "No file received. Send multipart/form-data with a field named 'file'."
    );
  }

  if (req.file.size === 0) {
    throw ApiError.badRequest("The uploaded file is empty.");
  }

  let driveFileId = null;

  try {
    const { uploaded, metadata } = await persistUpload({
      tempFile: req.file,
      body: req.body || {},
    });
    driveFileId = uploaded.id;

    const doc = await File.create({
      ...metadata,
      title: cleanText(req.body?.title, 200) || metadata.originalName,
      description: cleanText(req.body?.description, 2000) || "",
      isActive: true,
    });

    driveFileId = null; // committed; no longer needs compensating

    res.status(201).json({
      success: true,
      message: "File uploaded successfully",
      data: doc,
    });
  } finally {
    // Compensate for a database failure so Drive is not left holding a file
    // nothing references.
    if (driveFileId) await storage.deleteFileQuietly(driveFileId);
    await removeTempFile(req.file.path);
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/files                                                              */
/* -------------------------------------------------------------------------- */

export const getFiles = asyncHandler(async (req, res) => {
  const { fileType, search, sort = "-createdAt" } = req.query;

  // Unbounded list responses grow without limit as the store fills up.
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const filter = { isActive: true };

  if (fileType) {
    const requested = String(fileType).toLowerCase();
    if (!FILE_TYPES.includes(requested)) {
      throw ApiError.badRequest(
        `Invalid fileType '${fileType}'. Expected one of: ${FILE_TYPES.join(", ")}`
      );
    }
    filter.fileType = requested;
  }

  const folderName = cleanFolderName(req.query.folderName);
  if (folderName) {
    const folderId = await storage.findFolder(folderName);
    if (!folderId) throw ApiError.notFound(`Drive folder '${folderName}' not found`);
    filter.driveFolderId = folderId;
  }

  const term = cleanText(search, 100);
  if (term) {
    // Escaped so user input cannot inject regex metacharacters.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");
    filter.$or = [{ title: rx }, { description: rx }, { originalName: rx }];
  }

  const allowedSorts = new Set([
    "createdAt",
    "-createdAt",
    "title",
    "-title",
    "fileSize",
    "-fileSize",
  ]);
  const sortBy = allowedSorts.has(sort) ? sort : "-createdAt";

  const [data, total] = await Promise.all([
    File.find(filter)
      .sort(sortBy)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    File.countDocuments(filter),
  ]);

  res.json({
    success: true,
    count: data.length,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      hasNextPage: page * limit < total,
    },
    data,
  });
});

/* -------------------------------------------------------------------------- */
/* GET /api/files/:id                                                          */
/* -------------------------------------------------------------------------- */

export const getFileById = asyncHandler(async (req, res) => {
  assertValidObjectId(req.params.id);

  // Metadata only. Streaming is a separate, explicit endpoint so that listing
  // a folder never pulls megabytes through the server.
  const file = await File.findOne({ _id: req.params.id, isActive: true }).lean();

  if (!file) throw ApiError.notFound("File not found");

  res.json({ success: true, data: file });
});

/* -------------------------------------------------------------------------- */
/* GET /api/files/:id/stream                                                   */
/* -------------------------------------------------------------------------- */

export const streamFile = asyncHandler(async (req, res) => {
  assertValidObjectId(req.params.id);

  const file = await File.findOne({ _id: req.params.id, isActive: true }).lean();
  if (!file) throw ApiError.notFound("File not found");

  // Ranges are resolved against the size we stored at upload time, so the
  // Content-Range/Content-Length we send never depend on Drive's echo.
  const size = file.fileSize;
  const range = parseRange(req.headers.range, size);

  if (range?.unsatisfiable) {
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Range", `bytes */${size}`);
    return res.status(416).end();
  }

  const { stream, status } = await storage.streamFile(file.driveFileId, {
    range: range ? `bytes=${range.start}-${range.end}` : undefined,
  });

  // Drive may ignore a Range and send the whole body; describe what we
  // actually got rather than what we asked for.
  const partial = range && status === 206;

  // Never let the browser sniff its way to a different type than we declare,
  // and never render SVG/HTML inline on this origin.
  const forceDownload =
    shouldForceDownload(file.mimeType) ||
    req.query.download === "true" ||
    !isInlineRenderable(file.mimeType);

  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader(
    "Content-Disposition",
    contentDisposition(forceDownload ? "attachment" : "inline", file.originalName)
  );

  // Immutable content addressed by an id that never points at different bytes.
  res.setHeader("Cache-Control", "private, max-age=3600");

  if (partial) {
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader("Content-Length", range.end - range.start + 1);
    res.status(206);
  } else {
    res.setHeader("Content-Length", size);
    res.status(200);
  }

  // A viewer who seeks or navigates away aborts the request; without this the
  // Drive connection stays open and leaks a socket per abandoned stream.
  const abort = () => stream.destroy();
  res.on("close", abort);

  stream.on("error", (err) => {
    console.error(
      `[stream] failed for file ${file._id} (drive ${file.driveFileId}): ${err.message}`
    );
    // Headers are already flushed by now, so there is no way to send JSON.
    // Tearing down the socket signals the truncation to the client.
    res.destroy(err);
  });

  stream.pipe(res);
});

/* -------------------------------------------------------------------------- */
/* PATCH /api/files/:id                                                        */
/* -------------------------------------------------------------------------- */

export const updateFile = asyncHandler(async (req, res) => {
  assertValidObjectId(req.params.id);

  // Metadata only. Binary replacement goes through PUT /:id/replace so the
  // two very different failure modes stay separate.
  const updates = {};

  if (req.body.title !== undefined) {
    updates.title = cleanText(req.body.title, 200);
  }
  if (req.body.description !== undefined) {
    updates.description = cleanText(req.body.description, 2000);
  }
  if (req.body.fileType !== undefined) {
    const requested = String(req.body.fileType).toLowerCase();
    if (!FILE_TYPES.includes(requested)) {
      throw ApiError.badRequest(
        `Invalid fileType '${req.body.fileType}'. Expected one of: ${FILE_TYPES.join(", ")}`
      );
    }
    updates.fileType = requested;
  }

  if (Object.keys(updates).length === 0) {
    throw ApiError.badRequest(
      "Nothing to update. Provide title, description or fileType."
    );
  }

  const file = await File.findOneAndUpdate(
    { _id: req.params.id, isActive: true },
    { $set: updates },
    { new: true, runValidators: true }
  );

  if (!file) throw ApiError.notFound("File not found");

  res.json({
    success: true,
    message: "File metadata updated successfully",
    data: file,
  });
});

/* -------------------------------------------------------------------------- */
/* PUT /api/files/:id/replace                                                  */
/* -------------------------------------------------------------------------- */

export const replaceFile = asyncHandler(async (req, res) => {
  assertValidObjectId(req.params.id);

  if (!req.file) {
    throw ApiError.badRequest(
      "No file received. Send multipart/form-data with a field named 'file'."
    );
  }
  if (req.file.size === 0) {
    throw ApiError.badRequest("The uploaded file is empty.");
  }

  const existing = await File.findOne({ _id: req.params.id, isActive: true });
  if (!existing) {
    await removeTempFile(req.file.path);
    throw ApiError.notFound("File not found");
  }

  const oldDriveFileId = existing.driveFileId;
  let newDriveFileId = null;

  try {
    // Upload first, swap second, delete last. At no point is the record
    // pointing at something that does not exist: if the upload fails the old
    // file is untouched, and if the database write fails we remove the new
    // upload and leave the old one in place.
    const { uploaded, metadata } = await persistUpload({
      tempFile: req.file,
      body: req.body || {},
    });
    newDriveFileId = uploaded.id;

    existing.set({
      ...metadata,
      title: cleanText(req.body?.title, 200) ?? existing.title,
      description: cleanText(req.body?.description, 2000) ?? existing.description,
    });

    await existing.save();
    newDriveFileId = null; // committed

    // Only now is the old object unreferenced. A failure here is an orphan,
    // not data loss, so it is logged rather than surfaced.
    await storage.deleteFileQuietly(oldDriveFileId);

    res.json({
      success: true,
      message: "File replaced successfully",
      data: existing,
    });
  } finally {
    if (newDriveFileId) await storage.deleteFileQuietly(newDriveFileId);
    await removeTempFile(req.file.path);
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE /api/files/:id                                                       */
/* -------------------------------------------------------------------------- */

export const deleteFile = asyncHandler(async (req, res) => {
  assertValidObjectId(req.params.id);

  const permanent = req.query.permanent === "true";

  const file = await File.findById(req.params.id);
  if (!file || (!file.isActive && !permanent)) {
    throw ApiError.notFound("File not found");
  }

  if (!permanent) {
    // Default: the record is hidden from every read path but the bytes stay in
    // Drive, so an accidental delete is recoverable. Reads all filter on
    // isActive, so this is a real delete from the API's point of view.
    await file.softDelete();

    return res.json({
      success: true,
      message: "File deleted successfully",
      data: { _id: file._id, isActive: file.isActive, deletedAt: file.deletedAt },
    });
  }

  // Permanent: remove from Drive first. Dropping the record first would lose
  // the only reference to the Drive object if the delete then failed.
  try {
    await storage.deleteFile(file.driveFileId);
  } catch (err) {
    // Already gone in Drive is the outcome we wanted; proceed to clear the row.
    if (!storage.isNotFound(err)) throw err;
    console.warn(
      `[delete] Drive file ${file.driveFileId} was already missing; removing record.`
    );
  }

  await file.deleteOne();

  res.json({
    success: true,
    message: "File permanently deleted",
    data: { _id: file._id },
  });
});

/* -------------------------------------------------------------------------- */
/* POST /api/files/sync                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Register files that were put into Drive by hand (not through /upload), so
 * they show up in the list and stream endpoints.
 *
 * Idempotent: files already in MongoDB - including soft-deleted ones, which
 * must stay deleted - are skipped, so it is safe to run repeatedly.
 */
const syncFolder = async (folderName) => {
  const report = {
    folderName,
    folderId: null,
    scanned: 0,
    imported: 0,
    alreadyRegistered: 0,
    skipped: [],
  };

  const folderId = await storage.findFolder(folderName);
  if (!folderId) {
    report.error = `Drive folder '${folderName}' not found`;
    return report;
  }
  report.folderId = folderId;

  const driveFiles = [];
  let pageToken;
  do {
    const page = await storage.listFiles({ folderId, pageSize: 1000, pageToken });
    driveFiles.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);

  report.scanned = driveFiles.length;

  const candidates = [];
  for (const file of driveFiles) {
    if (storage.isFolder(file.mimeType)) {
      report.skipped.push({ name: file.name, reason: "subfolder" });
    } else if (file.mimeType.startsWith("application/vnd.google-apps.")) {
      // Google Docs/Sheets have no binary content to stream.
      report.skipped.push({ name: file.name, reason: "Google Workspace document" });
    } else if (!isAllowedMimeType(file.mimeType)) {
      report.skipped.push({ name: file.name, reason: `unsupported type ${file.mimeType}` });
    } else {
      candidates.push(file);
    }
  }

  if (candidates.length === 0) return report;

  const existing = await File.find(
    { driveFileId: { $in: candidates.map((f) => f.id) } },
    { driveFileId: 1 }
  ).lean();
  const known = new Set(existing.map((doc) => doc.driveFileId));
  report.alreadyRegistered = known.size;

  const docs = candidates
    .filter((file) => !known.has(file.id))
    .map((file) => {
      const originalName = sanitizeFileName(file.name);
      return {
        title: originalName.replace(/\.[^.]+$/, "") || originalName,
        description: "",
        originalName,
        fileName: file.name,
        mimeType: file.mimeType,
        fileSize: file.size,
        fileType: detectFileType(file.mimeType),
        driveFileId: file.id,
        driveFolderId: folderId,
        isActive: true,
      };
    });

  if (docs.length === 0) return report;

  try {
    const inserted = await File.insertMany(docs, { ordered: false });
    report.imported = inserted.length;
  } catch (err) {
    // A concurrent sync or upload registered some of these first; keep the rest.
    if (err.code !== 11000 && !err.writeErrors) throw err;
    report.imported = err.insertedDocs?.length ?? 0;
    report.alreadyRegistered += docs.length - report.imported;
  }

  return report;
};

export const syncFiles = asyncHandler(async (req, res) => {
  const requested = cleanFolderName(req.body?.folderName ?? req.query.folderName);
  const folderNames = requested
    ? [requested]
    : [...new Set(Object.values(env.typeFolders))];

  const folders = [];
  for (const name of folderNames) {
    folders.push(await syncFolder(name));
  }

  const totalImported = folders.reduce((sum, f) => sum + f.imported, 0);

  res.json({
    success: true,
    message: `Imported ${totalImported} new file(s) from Google Drive`,
    data: { totalImported, folders },
  });
});

/* -------------------------------------------------------------------------- */
/* GET /api/files/stats/summary                                                */
/* -------------------------------------------------------------------------- */

export const getStats = asyncHandler(async (_req, res) => {
  const byType = await File.aggregate([
    { $match: { isActive: true } },
    {
      $group: {
        _id: "$fileType",
        count: { $sum: 1 },
        totalSize: { $sum: "$fileSize" },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const totals = byType.reduce(
    (acc, row) => ({
      count: acc.count + row.count,
      totalSize: acc.totalSize + row.totalSize,
    }),
    { count: 0, totalSize: 0 }
  );

  res.json({
    success: true,
    data: {
      totalFiles: totals.count,
      totalSizeBytes: totals.totalSize,
      totalSizeMB: Number((totals.totalSize / (1024 * 1024)).toFixed(2)),
      maxUploadSizeMB: Math.round(env.maxFileSizeBytes / (1024 * 1024)),
      byType: byType.map((row) => ({
        fileType: row._id,
        count: row.count,
        totalSizeBytes: row.totalSize,
      })),
    },
  });
});
