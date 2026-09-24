import app from "./app.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { assertEnv, env } from "./config/env.js";
import { storage } from "./services/storageService.js";
import { sweepTempFiles } from "./utils/tempFiles.js";

const start = async () => {
  assertEnv();

  await connectDB();

  // Confirm the credentials and folder actually work now, rather than
  // discovering it on a user's first upload.
  try {
    const folder = await storage.verifyAccess();
    console.log(`[drive] connected; root folder "${folder.name}" (${folder.id})`);
  } catch (err) {
    console.error(
      `[drive] could not access GOOGLE_DRIVE_FOLDER_ID: ${err.message}\n` +
        "        Share the folder with the service account email, or check " +
        "GOOGLE_SHARED_DRIVE_ID."
    );
    // Non-fatal: metadata routes still work, and a transient Drive outage
    // should not stop the process from booting.
  }

  await sweepTempFiles();
  const sweepTimer = setInterval(() => sweepTempFiles(), 60 * 60 * 1000);
  sweepTimer.unref();

  const server = app.listen(env.port, () => {
    console.log(`[server] listening on port ${env.port} (${env.nodeEnv})`);
  });

  // Media streams are long-lived; give them room before the proxy cuts in.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;

  const shutdown = async (signal) => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    // Do not hang forever on an in-flight stream.
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason);
});

start().catch((err) => {
  console.error("[fatal] startup failed:", err.message);
  process.exit(1);
});
