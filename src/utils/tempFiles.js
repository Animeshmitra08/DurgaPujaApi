import fs from "fs/promises";
import path from "path";
import { env } from "../config/env.js";

/**
 * Delete a temp file without ever throwing. Cleanup runs in finally blocks and
 * in the error handler, where a second failure would mask the original one.
 */
export const removeTempFile = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[tmp] could not remove ${filePath}: ${err.message}`);
    }
  }
};

/**
 * Sweep temp files left behind by a crash or a hard restart.
 *
 * Belt and braces: the request path already cleans up after itself, but a
 * process killed mid-upload never gets the chance, and on a long-lived
 * instance those leftovers accumulate.
 */
export const sweepTempFiles = async (maxAgeMs = 60 * 60 * 1000) => {
  try {
    const entries = await fs.readdir(env.uploadTmpDir);
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const entry of entries) {
      const fullPath = path.join(env.uploadTmpDir, entry);
      try {
        const stats = await fs.stat(fullPath);
        if (stats.isFile() && stats.mtimeMs < cutoff) {
          await fs.unlink(fullPath);
          removed += 1;
        }
      } catch {
        // file vanished between readdir and stat - fine
      }
    }

    if (removed > 0) console.log(`[tmp] swept ${removed} stale upload(s)`);
  } catch (err) {
    console.warn(`[tmp] sweep failed: ${err.message}`);
  }
};
