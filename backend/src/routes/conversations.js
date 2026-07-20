import { Router } from "express";
import {
  listConversations,
  listMessages,
  getContact,
  getLatestInboundWamid,
  archiveContact,
  deleteConversation,
} from "../db.js";
import { markAsRead } from "../graphApi.js";

const router = Router();

router.get("/", (req, res) => {
  const includeArchived = req.query.archived === "1";
  const conversations = listConversations(includeArchived).map((c) => ({
    ...c,
    window_open: c.window_expires_at > Date.now(),
  }));
  res.json(conversations);
});

router.post("/:waId/read", async (req, res) => {
  const wamid = getLatestInboundWamid(req.params.waId);
  if (!wamid) return res.json({ ok: true, skipped: "no inbound messages" });
  try {
    await markAsRead(wamid);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/:waId/archive", (req, res) => {
  archiveContact(req.params.waId, true);
  res.json({ ok: true });
});

router.post("/:waId/unarchive", (req, res) => {
  archiveContact(req.params.waId, false);
  res.json({ ok: true });
});

// Hard delete - removes the contact and its full message history. Archive
// is the safer default in the UI; this is offered as an explicit follow-up
// action behind a confirmation, not the first click.
router.delete("/:waId", (req, res) => {
  deleteConversation(req.params.waId);
  res.json({ ok: true });
});

router.get("/:waId/messages", (req, res) => {
  res.json(listMessages(req.params.waId));
});

router.get("/:waId", (req, res) => {
  const contact = getContact(req.params.waId);
  if (!contact) return res.sendStatus(404);
  res.json({ ...contact, window_open: contact.window_expires_at > Date.now() });
});

export default router;
