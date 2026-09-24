import { Router } from "express";
import {
  deleteFile,
  getFileById,
  getFiles,
  getStats,
  replaceFile,
  streamFile,
  syncFiles,
  updateFile,
  uploadFile,
} from "../controllers/fileController.js";
import { requireApiKey } from "../middleware/auth.js";
import { uploadSingle } from "../middleware/upload.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

/* Reads are open; writes sit behind the API key when one is configured. */

// Must be declared before /:id so 'stats' is not parsed as an id.
router.get("/stats/summary", getStats);

router.post("/upload", requireApiKey, uploadSingle, uploadFile);
router.post("/sync", requireApiKey, syncFiles);
// Otherwise GET /sync falls through to /:id and fails as "Invalid file id".
router.get("/sync", (_req, _res, next) =>
  next(new ApiError(405, "Use POST /api/files/sync to import files from Google Drive."))
);

router.get("/", getFiles);
router.get("/:id", getFileById);
router.get("/:id/stream", streamFile);

router.patch("/:id", requireApiKey, updateFile);
router.put("/:id/replace", requireApiKey, uploadSingle, replaceFile);
router.delete("/:id", requireApiKey, deleteFile);

export default router;
