import dns from "node:dns";
import mongoose from "mongoose";
import { env } from "./env.js";

// On some Windows networks the only system resolver is an IPv6 link-local
// address that Node cannot use, so it falls back to 127.0.0.1 and the
// mongodb+srv SRV lookup fails with ECONNREFUSED. Use public DNS instead.
const ensureUsableDns = () => {
  const servers = dns.getServers();
  const onlyLoopback = servers.every((s) => s === "127.0.0.1" || s === "::1");
  if (onlyLoopback) {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
    console.warn(
      `[db] system DNS unusable by Node (${servers.join(", ")}); using 8.8.8.8, 1.1.1.1`
    );
  }
};

export const connectDB = async () => {
  mongoose.set("strictQuery", true);
  ensureUsableDns();

  console.log("[db] connecting to MongoDB...");

  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 10000,
      // Streaming responses hold connections open; a slightly larger pool keeps
      // metadata reads from queueing behind them.
      maxPoolSize: 20,
    });
  } catch (err) {
    console.error("[db] failed to connect to MongoDB:", err.message);
    throw err;
  }

  const { host, name } = mongoose.connection;
  console.log(`[db] MongoDB connected: host=${host} database=${name}`);

  mongoose.connection.on("error", (err) => {
    console.error("[db] connection error:", err.message);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("[db] disconnected");
  });

  mongoose.connection.on("reconnected", () => {
    console.log(`[db] MongoDB reconnected: host=${host} database=${name}`);
  });

  return mongoose.connection;
};

export const disconnectDB = () => mongoose.connection.close(false);
