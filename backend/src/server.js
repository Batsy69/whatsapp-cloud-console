import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import webhookRoute from "./routes/webhook.js";
import conversationsRoute from "./routes/conversations.js";
import sendRoute from "./routes/send.js";
import templatesRoute from "./routes/templates.js";
import broadcastRoute, { resumeUnfinishedJobs } from "./routes/broadcast.js";
import mediaRoute from "./routes/media.js";
import directoryRoute from "./routes/directory.js";
import groupsRoute from "./routes/groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

app.use("/webhook", webhookRoute);
app.use("/api/conversations", conversationsRoute);
app.use("/api/send", sendRoute);
app.use("/api/templates", templatesRoute);
app.use("/api/broadcast", broadcastRoute);
app.use("/api/media", mediaRoute);
app.use("/api/directory", directoryRoute);
app.use("/api/groups", groupsRoute);

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Serve the built frontend (see frontend/README) as static files, so the
// whole thing ships as one container.
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/webhook")) return next();
  res.sendFile(path.join(publicDir, "index.html"), (err) => err && next());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WA Cloud dashboard backend listening on :${PORT}`);
  resumeUnfinishedJobs();
});
