/**
 * Storage provider seam.
 *
 * Controllers import from this module only. They speak in uploadFile /
 * getFile / streamFile / deleteFile and know nothing about drive.files.create,
 * Shared Drive flags, or Google's error reasons.
 *
 * Swapping Drive for S3, GCS or Azure Blob means writing one more module with
 * this shape and changing the import below - no controller changes.
 */
import * as googleDrive from "./googleDriveService.js";

export const storage = {
  name: "google-drive",

  /** @see googleDriveService.uploadFile */
  uploadFile: googleDrive.uploadFile,

  /** Metadata from the provider (MongoDB remains the source of truth). */
  getFile: googleDrive.getFileMetadata,

  /** Range-aware read stream. */
  streamFile: googleDrive.getFileStream,

  deleteFile: googleDrive.deleteFile,

  /** Never throws; logs orphans for reconciliation. */
  deleteFileQuietly: googleDrive.deleteFileQuietly,

  listFiles: googleDrive.listFiles,

  /** Resolve a folder name to an ID, creating it when absent. */
  ensureFolder: googleDrive.ensureFolder,

  /** Resolve a folder name to an ID, or null when absent. */
  findFolder: googleDrive.findFolder,

  isFolder: googleDrive.isFolderMimeType,

  verifyAccess: googleDrive.verifyAccess,

  isNotFound: googleDrive.isDriveNotFound,
};

export default storage;
