import { Router } from "express";
import { upsertContact, insertMessage, updateMessageStatus } from "../db.js";

const router = Router();

// Meta calls this once, when you register the webhook URL in the App Dashboard.
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function parseInbound(msg) {
  // Returns { body, media_id, mime_type, latitude, longitude }
  switch (msg.type) {
    case "text":
      return { body: msg.text?.body || "" };
    case "image":
      return { body: msg.image?.caption || "[image]", media_id: msg.image?.id, mime_type: msg.image?.mime_type };
    case "video":
      return { body: msg.video?.caption || "[video]", media_id: msg.video?.id, mime_type: msg.video?.mime_type };
    case "audio":
      return { body: "[audio]", media_id: msg.audio?.id, mime_type: msg.audio?.mime_type };
    case "document":
      return {
        body: msg.document?.caption || msg.document?.filename || "[document]",
        media_id: msg.document?.id,
        mime_type: msg.document?.mime_type,
      };
    case "sticker":
      return { body: "[sticker]", media_id: msg.sticker?.id, mime_type: msg.sticker?.mime_type };
    case "location":
      return {
        body: msg.location?.name || msg.location?.address || "[location]",
        latitude: msg.location?.latitude,
        longitude: msg.location?.longitude,
      };
    case "button":
      return { body: msg.button?.text || "[button reply]" };
    case "interactive":
      return {
        body:
          msg.interactive?.button_reply?.title ||
          msg.interactive?.list_reply?.title ||
          "[interactive reply]",
      };
    case "reaction":
      return { body: msg.reaction?.emoji ? `reacted ${msg.reaction.emoji}` : "[reaction removed]" };
    case "contacts":
      return { body: `[contact card: ${msg.contacts?.[0]?.name?.formatted_name || "unnamed"}]` };
    default:
      return { body: `[unsupported type: ${msg.type}]` };
  }
}

// Meta POSTs every inbound message and every status update (sent/delivered/read/failed) here.
router.post("/", (req, res) => {
  // Always 200 quickly - Meta retries with backoff if you don't, which can
  // duplicate events. Do the real work synchronously since it's cheap (SQLite).
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        for (const msg of value.messages || []) {
          const contactName = (value.contacts || []).find((c) => c.wa_id === msg.from)?.profile?.name;
          upsertContact(msg.from, contactName);

          const parsed = parseInbound(msg);

          insertMessage({
            wa_id: msg.from,
            wamid: msg.id,
            direction: "inbound",
            type: msg.type,
            body: parsed.body,
            template_name: null,
            status: "received",
            timestamp: Number(msg.timestamp) * 1000,
            raw: JSON.stringify(msg),
            media_id: parsed.media_id || null,
            mime_type: parsed.mime_type || null,
            latitude: parsed.latitude ?? null,
            longitude: parsed.longitude ?? null,
          });
        }

        for (const status of value.statuses || []) {
          updateMessageStatus(status.id, status.status);
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }

  res.sendStatus(200);
});

export default router;
