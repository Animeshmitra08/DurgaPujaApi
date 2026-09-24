import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import fileRoutes from "./routes/fileRoutes.js";

const app = express();

// Behind a load balancer (Render, Railway, Heroku) so req.ip and protocol
// come from the forwarding headers.
app.set("trust proxy", 1);
app.disable("x-powered-by");

const allowAllOrigins =
  env.corsOrigins.length === 0 || env.corsOrigins.includes("*");

app.use(
  cors({
    origin: allowAllOrigins ? true : env.corsOrigins,
    credentials: !allowAllOrigins,
    // Range/Content-Range must be exposed or browsers cannot use the 206
    // responses the stream endpoint returns for media seeking.
    exposedHeaders: [
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Content-Disposition",
    ],
  })
);

// Multipart bodies are parsed by multer, not here; these limits apply to the
// JSON and form endpoints only.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.get("/health", (_req, res) => {
  const dbStates = ["disconnected", "connected", "connecting", "disconnecting"];
  res.json({
    success: true,
    status: "ok",
    uptime: Math.round(process.uptime()),
    database: dbStates[mongoose.connection.readyState] || "unknown",
    storage: "google-drive",
    environment: env.nodeEnv,
  });
});

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "Google Drive Storage API",
    endpoints: {
      upload: "POST /api/files/upload (folderName optional: images/audios chosen by type)",
      sync: "POST /api/files/sync?folderName= (import files added directly in Drive)",
      list: "GET /api/files?fileType=&folderName=&page=&limit=&search=",
      metadata: "GET /api/files/:id",
      stream: "GET /api/files/:id/stream",
      update: "PATCH /api/files/:id",
      replace: "PUT /api/files/:id/replace",
      delete: "DELETE /api/files/:id?permanent=false",
      stats: "GET /api/files/stats/summary",
    },
  });
});

app.use("/api/files", fileRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
