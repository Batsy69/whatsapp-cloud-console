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
// Default Express limit (100kb) is too small for a bulk broadcast/import
// payload - a few thousand recipients with personalization variables each
// easily exceeds it, which would silently 413 on exactly the "thousands of
// numbers" use case this app is built for. `verify` captures the raw body
// bytes too, needed to check Meta's webhook signature further down.
app.use(
  express.json({
    limit: "25mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// --- Access control ---
// Everything in this app - conversations, broadcasts, contacts - is wide
// open with no login unless these are set. If deployed on a public domain
// (which Coolify gives you by default) without this, anyone who finds the
// URL can read your customers' conversations and send messages as your
// business. Not enforced unless configured, so this doesn't break an
// existing deployment on upgrade - but it's loudly logged either way.
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;

if (!AUTH_USER || !AUTH_PASS) {
  console.warn(
    "\n⚠️  WARNING: BASIC_AUTH_USER / BASIC_AUTH_PASS are not set.\n" +
      "   This console is running with NO LOGIN. Anyone with the URL can read\n" +
      "   your conversations and send broadcasts as your business. Set both\n" +
      "   env vars to require a login.\n"
  );
} else {
  app.use((req, res, next) => {
    if (req.path.startsWith("/webhook") || req.path === "/api/health") return next();

    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (user === AUTH_USER && pass === AUTH_PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="WhatsApp Cloud Console"');
    res.sendStatus(401);
  });
}

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
  if (!process.env.META_APP_SECRET) {
    console.warn(
      "⚠️  WARNING: META_APP_SECRET is not set - inbound webhook payloads are not\n" +
        "   signature-verified, so anyone could POST a fabricated payload to /webhook.\n" +
        "   Set META_APP_SECRET (App Dashboard > Settings > Basic) to enable this check.\n"
    );
  }
  resumeUnfinishedJobs();
});
