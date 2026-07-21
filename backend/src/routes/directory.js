import { Router } from "express";
import { listDirectory, upsertDirectoryContact, deleteConversation } from "../db.js";
import { normalizePhone } from "../phone.js";

const router = Router();

router.get("/", (req, res) => {
  const rows = listDirectory(req.query.group_id ? Number(req.query.group_id) : null, req.query.failed === "1");
  res.json(rows.map((r) => ({ ...r, custom_fields: r.custom_fields ? JSON.parse(r.custom_fields) : null })));
});

// Manual add / edit - upsert a single contact.
router.post("/", (req, res) => {
  const { wa_id, name, company, city, state, email, custom_fields, group_id } = req.body;
  if (!wa_id) return res.status(400).json({ error: "wa_id is required" });
  upsertDirectoryContact({
    wa_id: normalizePhone(wa_id),
    name,
    company,
    city,
    state,
    email,
    custom_fields,
    group_id: group_id || null,
  });
  res.json({ ok: true });
});

// Bulk import - array of { wa_id, name?, company?, city?, state?, email?, custom_fields?, group_id? }.
// Used for CSV imports of thousands of contacts at once (parsed client-side, sent here as JSON).
router.post("/import", (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows array is required" });
  }
  let imported = 0;
  for (const r of rows) {
    const wa_id = normalizePhone(r.wa_id);
    if (!wa_id) continue;
    upsertDirectoryContact({ ...r, wa_id });
    imported++;
  }
  res.json({ imported, skipped: rows.length - imported });
});

router.delete("/:waId", (req, res) => {
  deleteConversation(req.params.waId);
  res.json({ ok: true });
});

export default router;
