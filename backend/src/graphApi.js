const VERSION = process.env.GRAPH_API_VERSION || "v23.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WABA_ID = process.env.WHATSAPP_WABA_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const BASE = `https://graph.facebook.com/${VERSION}`;

async function graphFetch(pathSuffix, options = {}) {
  const res = await fetch(`${BASE}${pathSuffix}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Graph API error (${res.status})`);
    err.details = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- Messages ---

export function sendTextMessage(to, body) {
  return graphFetch(`/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body },
    }),
  });
}

export function sendTemplateMessage(to, templateName, languageCode, components = []) {
  return graphFetch(`/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    }),
  });
}

export function sendMediaMessage(to, type, mediaId, caption, filename) {
  const mediaObj = { id: mediaId };
  if (caption && ["image", "video", "document"].includes(type)) mediaObj.caption = caption;
  if (filename && type === "document") mediaObj.filename = filename;

  return graphFetch(`/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type,
      [type]: mediaObj,
    }),
  });
}

export function sendLocationMessage(to, latitude, longitude, name, address) {
  return graphFetch(`/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "location",
      location: { latitude, longitude, name, address },
    }),
  });
}

// Interactive reply-button message - up to 3 buttons, each with an id you
// choose (comes back in the webhook as interactive.button_reply.id when tapped).
export function sendInteractiveButtons(to, bodyText, buttons) {
  return graphFetch(`/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
        },
      },
    }),
  });
}

// --- Media ---
// Two-step flow per Meta's docs: upload the binary to get a short-lived
// media_id, then reference that id in a message. Separately, an inbound
// media_id must be resolved to a temporary signed URL before you can fetch
// the actual bytes - that URL requires the same Bearer token to download.

export async function uploadMedia(buffer, mimeType, filename) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const res = await fetch(`${BASE}/${PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Media upload failed (${res.status})`);
    err.details = data;
    err.status = res.status;
    throw err;
  }
  return data; // { id }
}

export function getMediaMeta(mediaId) {
  return graphFetch(`/${mediaId}`, { method: "GET" });
}

export async function fetchMediaBinary(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw Object.assign(new Error(`Media download failed (${res.status})`), { status: res.status });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: res.headers.get("content-type") };
}

// --- Resumable Upload API (template header media only) ---
// This is a *different* upload flow from uploadMedia() above - that one
// gets a media_id for sending a message; this one gets a "handle" string
// that goes in a template's HEADER component so Meta has a sample to review.
// Docs: https://developers.facebook.com/docs/graph-api/guides/upload
//
// Handles are short-lived (create the template within ~24h of uploading).

const APP_ID = process.env.META_APP_ID;

export async function uploadTemplateHeaderMedia(buffer, mimeType, filename) {
  if (!APP_ID) {
    const err = new Error("META_APP_ID is not set - required for template header media uploads");
    err.status = 500;
    throw err;
  }

  // Step 1: start an upload session, sized for this exact file.
  const sessionParams = new URLSearchParams({
    file_name: filename,
    file_length: String(buffer.length),
    file_type: mimeType,
    access_token: TOKEN,
  });
  const sessionRes = await fetch(`${BASE}/${APP_ID}/uploads?${sessionParams.toString()}`, {
    method: "POST",
  });
  const sessionData = await sessionRes.json().catch(() => ({}));
  if (!sessionRes.ok) {
    const err = new Error(sessionData?.error?.message || `Upload session failed (${sessionRes.status})`);
    err.details = sessionData;
    err.status = sessionRes.status;
    throw err;
  }
  const uploadSessionId = sessionData.id; // "upload:<id>"

  // Step 2: push the actual bytes to that session.
  const uploadRes = await fetch(`${BASE}/${uploadSessionId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${TOKEN}`,
      file_offset: "0",
    },
    body: buffer,
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) {
    const err = new Error(uploadData?.error?.message || `File upload failed (${uploadRes.status})`);
    err.details = uploadData;
    err.status = uploadRes.status;
    throw err;
  }

  return uploadData.h; // the header_handle string
}

export function markAsRead(wamid) {
  return graphFetch(`/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: wamid,
    }),
  });
}

// --- Templates ---
// Note: templates are approved async by Meta. A newly created template
// stays PENDING until reviewed, it cannot be sent immediately.

export function listTemplates() {
  return graphFetch(`/${WABA_ID}/message_templates?limit=200`, { method: "GET" });
}

export function createTemplate({ name, category, language, components }) {
  return graphFetch(`/${WABA_ID}/message_templates`, {
    method: "POST",
    body: JSON.stringify({ name, category, language, components }),
  });
}

export function deleteTemplate(name) {
  return graphFetch(`/${WABA_ID}/message_templates?name=${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}
