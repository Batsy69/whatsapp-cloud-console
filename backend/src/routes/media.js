import { Router } from "express";
import multer from "multer";
import { uploadMedia, getMediaMeta, fetchMediaBinary } from "../graphApi.js";

// Meta caps documents at 100MB; images/video/audio have lower per-type
// limits that Meta enforces itself on the send call.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const router = Router();

router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  try {
    const data = await uploadMedia(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ media_id: data.id, mime_type: req.file.mimetype, filename: req.file.originalname });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

// Media IDs expire and their URLs are signed + auth-gated, so the frontend
// can't hit graph.facebook.com directly - it always goes through this proxy.
router.get("/:id", async (req, res) => {
  try {
    const meta = await getMediaMeta(req.params.id);
    const { buffer, contentType } = await fetchMediaBinary(meta.url);
    res.set("Content-Type", contentType || meta.mime_type || "application/octet-stream");
    res.set("Cache-Control", "private, max-age=300");
    res.send(buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
