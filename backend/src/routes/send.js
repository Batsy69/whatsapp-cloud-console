import { Router } from "express";
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendLocationMessage,
  sendInteractiveButtons,
} from "../graphApi.js";
import { insertMessage, touchOutbound, getContact } from "../db.js";
import { normalizePhone } from "../phone.js";

const router = Router();
const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"];
const FREE_FORM_TYPES = ["text", ...MEDIA_TYPES, "location", "interactive_buttons"];

router.post("/", async (req, res) => {
  const {
    to: rawTo,
    type,
    text,
    media_id,
    caption,
    filename,
    latitude,
    longitude,
    name,
    address,
    body_text,
    buttons,
    template_name,
    language_code,
    components,
    display_body,
  } = req.body;

  if (!rawTo || !type) return res.status(400).json({ error: "to and type are required" });
  const to = normalizePhone(rawTo);

  try {
    let result;
    let storedBody;
    let storedMedia = null;
    let storedLat = null;
    let storedLng = null;

    if (type === "template") {
      result = await sendTemplateMessage(to, template_name, language_code, components || []);
      storedBody = display_body || `[template: ${template_name}]`;
    } else if (FREE_FORM_TYPES.includes(type)) {
      // Every non-template send requires an open 24h customer service window.
      // Meta's API enforces this too (error 131047) - this check just fails fast.
      const contact = getContact(to);
      if (!contact || contact.window_expires_at < Date.now()) {
        return res.status(409).json({
          error:
            "24-hour customer service window is closed for this contact. Send an approved template instead.",
        });
      }

      if (type === "text") {
        result = await sendTextMessage(to, text);
        storedBody = text;
      } else if (MEDIA_TYPES.includes(type)) {
        if (!media_id) return res.status(400).json({ error: "media_id is required for media messages" });
        result = await sendMediaMessage(to, type, media_id, caption, filename);
        storedBody = caption || filename || `[${type}]`;
        storedMedia = media_id;
      } else if (type === "location") {
        if (latitude == null || longitude == null)
          return res.status(400).json({ error: "latitude and longitude are required" });
        result = await sendLocationMessage(to, latitude, longitude, name, address);
        storedBody = name || address || `${latitude}, ${longitude}`;
        storedLat = latitude;
        storedLng = longitude;
      } else if (type === "interactive_buttons") {
        if (!Array.isArray(buttons) || buttons.length === 0)
          return res.status(400).json({ error: "buttons array is required" });
        result = await sendInteractiveButtons(to, body_text, buttons);
        storedBody = body_text;
      }
    } else {
      return res.status(400).json({ error: `Unsupported type: ${type}` });
    }

    const wamid = result?.messages?.[0]?.id || null;

    insertMessage({
      wa_id: to,
      wamid,
      direction: "outbound",
      type,
      body: storedBody,
      template_name: type === "template" ? template_name : null,
      status: "queued", // Meta accepted the request - this isn't delivery confirmation, that's async via webhook
      timestamp: Date.now(),
      raw: JSON.stringify(result),
      media_id: storedMedia,
      latitude: storedLat,
      longitude: storedLng,
    });
    touchOutbound(to);

    res.json({ ok: true, wamid, result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

export default router;
