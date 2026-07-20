import { Router } from "express";
import multer from "multer";
import { listTemplates, createTemplate, deleteTemplate, uploadTemplateHeaderMedia } from "../graphApi.js";

// Meta caps documents at 100MB; images/video/audio have lower per-type
// limits that Meta enforces itself on the upload call.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const router = Router();

router.get("/", async (req, res) => {
  try {
    const data = await listTemplates();
    res.json(data.data || []);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

// Step 1+2 of the resumable upload flow, combined into one call for the frontend.
// Returns a header_handle to drop into a HEADER component's `example` field.
router.post("/upload-header-media", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  try {
    const handle = await uploadTemplateHeaderMedia(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ handle, mime_type: req.file.mimetype, filename: req.file.originalname });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

router.post("/", async (req, res) => {
  const { name, category, language, components } = req.body;
  if (!name || !category || !language || !components) {
    return res
      .status(400)
      .json({ error: "name, category, language, and components are required" });
  }
  try {
    const data = await createTemplate({ name, category, language, components });
    // data.status will be PENDING - Meta reviews before it becomes usable
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

router.delete("/:name", async (req, res) => {
  try {
    const data = await deleteTemplate(req.params.name);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

export default router;
