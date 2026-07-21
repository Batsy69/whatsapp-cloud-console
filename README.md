# WhatsApp Cloud API Console

A self-hosted frontend for the official WhatsApp Business Cloud API (Meta Graph API) —
inbox, template management, and broadcast sending. Talks to `graph.facebook.com` directly,
no third-party wrapper.

## What's inside

- `backend/` — Express + SQLite. Holds your permanent access token, receives the
  webhook, stores every inbound/outbound message, and wraps the four Graph API
  calls you need (send, list templates, create template, delete template).
- `frontend/` — React (Vite). Three views: Inbox, Templates, Broadcast.
- `Dockerfile` / `docker-compose.yml` — builds the frontend and serves it from the
  backend as one container, ready to deploy on Coolify (or anywhere Docker runs).

## 1. Get your Meta credentials

Follow Meta's own [Get Started guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started) —
steps 1-3 there give you the Phone Number ID and WABA ID, step 5 gives you a
**permanent** system-user access token (don't use the temporary token from Step 3,
it expires in 24h).

## 2. Local development

```bash
# Backend
cd backend
cp .env.example .env   # fill in your credentials
npm install
npm run dev             # http://localhost:3000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev              # http://localhost:5173, proxies /api to :3000
```

For local webhook testing, tunnel port 3000 with something like `ngrok http 3000`
and register `https://<your-ngrok-domain>/webhook` in the Meta App Dashboard
(WhatsApp > Configuration), using the same `WEBHOOK_VERIFY_TOKEN` from your `.env`.

## 3. Deploy on Coolify

1. Push this repo to GitHub.
2. In Coolify: New Resource → Docker Compose (or Dockerfile) → point at this repo.
3. Set the environment variables from `backend/.env.example` in Coolify's UI —
   `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_ACCESS_TOKEN`,
   `WEBHOOK_VERIFY_TOKEN`.
4. Deploy. Coolify gives you a public HTTPS domain automatically.
5. In the Meta App Dashboard, set the webhook callback URL to
   `https://<your-coolify-domain>/webhook` and the verify token to match
   `WEBHOOK_VERIFY_TOKEN`. Subscribe to the `messages` field.
6. Mount the `data/` directory (already set up in `docker-compose.yml`) to a
   persistent volume so message history survives redeploys.

## Feature coverage

**Inbox**
- Text, image, video, audio, document, sticker, location, and interactive-reply
  messages — both directions, rendered natively (inline image/video/audio
  playback, document download link, map link for location)
- Attach button uploads and sends any file type; a location button sends
  lat/lng + optional label
- Read receipts sent automatically when you open a conversation
- Live per-contact 24h customer service window indicator that gates the reply UI
- Archive/unarchive and permanent delete per conversation, with a toggle to
  view the archived list separately from the active inbox

**Contacts (directory + groups)**
- A dedicated Contacts tab, separate from the Inbox — a real address book, not
  just a chat list. Every successful broadcast auto-saves the recipient here
  (this already happened under the hood before; now it's actually visible)
- Manual add or bulk CSV import with rich fields: Name, Company, City, State,
  Email, plus **any other column** your CSV has — unrecognized headers are
  kept as free-form custom fields per contact (e.g. GST number, order
  history, whatever you throw at it)
- Group contacts into categories (e.g. "Dealers - Maharashtra"). One click
  sends a broadcast to everyone in a group — no manual number-pasting needed
- When broadcasting to a group, you can map each template variable (`{{1}}`,
  `{{2}}`, ...) to a stored contact field (name, company, city, ...), so one
  broadcast personalizes per recipient using data already in the directory,
  not just uniform CSV rows

**Broadcast scheduling**
- Toggle "Schedule for later" and pick a date/time instead of sending
  immediately. A lightweight background check (every 30s) fires scheduled
  jobs when they come due — including catching up on anything that was due
  while the server was down (e.g. mid-redeploy)
- Scheduled broadcasts show up in history as `scheduled` and can be
  cancelled before they fire

**Failure tracking**
- Every broadcast attempt (success or failure) is recorded directly on the
  contact, not just buried in that one job's history — so a failure stays
  visible wherever you're looking, not only while that specific job is open
- The Contacts table's Status badge shows the **most recent** attempt only
  (a quick glance, not a full record) — click it to expand that contact's
  **complete broadcast history**, every campaign ever sent to them with its
  own result and error, so an older failure doesn't get hidden just because
  a later, different broadcast to the same person succeeded
- A "⚠ Failed sends" filter appears in the Contacts sidebar whenever there
  are any, showing exactly who didn't receive their *last* broadcast and why
- The badge (and the filter) **self-clears** the moment a later send to that
  contact succeeds — the underlying history never does, it's a permanent log
- From a completed broadcast's progress panel, "Retry N failed" spins up a
  new job targeting only the numbers that failed, reusing the same template
  and their original per-recipient variables
- Numbers are normalized before every send/broadcast/manual add: a bare
  10-digit number (e.g. `8655357804`) gets the default country code
  prefixed (`91` unless you set `DEFAULT_COUNTRY_CODE`), so it doesn't
  create a duplicate "phantom" conversation separate from the same
  contact's real, Meta-supplied `wa_id` (e.g. `918655357804`). Broadcast
  recipients are also deduplicated after normalization.

**Templates**
- Full component builder: HEADER (text, or image/video/document with a real
  sample file uploaded via Meta's resumable upload API), BODY with `{{n}}`
  variables, FOOTER, and up to 3 BUTTONS (quick reply, URL, phone number —
  including a dynamic `{{1}}` suffix on a URL button)
- Live status from Meta (`PENDING` / `APPROVED` / `REJECTED`), delete

**Broadcast**
- Only lists `APPROVED` templates (Meta rejects sends against pending ones)
- Renders header/body/footer/button variable inputs based on what the
  selected template actually needs, including the dynamic URL button case
- **Bulk send**: paste numbers directly, upload a CSV, or pick a saved group
  from Contacts. A CSV with just a phone column sends the same shared
  variable values to everyone; a CSV with extra columns
  (`phone,value1,value2,...`) personalizes the BODY variables per recipient
  while header/button variables stay shared across the job
- **Review before sending**: every broadcast goes through an editable preview
  table first — check/uncheck individual recipients, edit any recipient's
  variable values or phone number inline, or apply one value to every row at
  once. Paginated at 50 rows so this stays usable at thousands of recipients;
  de-duplication runs here too, so what you review matches what actually sends
- Sends run as a background job on the server (not held open in one HTTP
  request), so lists of thousands work without timing out. The frontend
  polls live progress — a bar, sent/failed counts, and recent failure
  reasons — and a broadcast history list lets you revisit past jobs and
  export the full per-recipient results as CSV
- If the server restarts mid-broadcast (e.g. a redeploy), any job still
  `running` resumes automatically on the next startup

## Notes on how this maps to Meta's rules

- **Template media headers (resumable upload)**: choosing an IMAGE/VIDEO/DOCUMENT
  header in the Templates tab uploads a real sample file through Meta's two-step
  Resumable Upload API (`POST /{app-id}/uploads` to start a session sized for
  the file, then `POST /upload:<session-id>` with the raw bytes and an `OAuth`
  auth header) to get a `header_handle`, which goes into the component's
  `example` field. This needs `META_APP_ID` set (your app's numeric ID from
  App Dashboard > Settings > Basic — same app your system user token belongs
  to). Handles expire in ~24h, so submit the template soon after uploading.
  Meta only accepts `image/jpeg`, `image/jpg`, `image/png`, `video/mp4`, and
  `application/pdf` for this endpoint — the file picker is restricted accordingly.
- **24-hour window**: `db.js` sets `window_expires_at` = last inbound message + 24h.
  The Inbox only shows the free-text reply box while that window is open; outside
  it, only templates can be sent (Meta enforces this server-side too — error
  `131047` — this is just so the UI reflects it before you hit that wall).
- **Template review**: newly created templates come back `PENDING`. The Broadcast
  view only lists `APPROVED` templates, since Meta will reject a send against a
  pending one.
- **No native message history**: everything in the Inbox is what your own webhook
  has captured and stored in SQLite since this app went live — Meta doesn't backfill
  past conversations.
- **Broadcast pacing**: sends are sequential with a small delay (see `delay_ms` in
  `backend/src/routes/broadcast.js`). Fine for a few hundred recipients; for real
  volume, swap that loop for a proper job queue (e.g. BullMQ) so it isn't holding
  one HTTP request open.

## Extending

- Media messages (image/document/video): already implemented for chat sends —
  see `backend/src/routes/send.js` and the attach button in the Inbox.
- Syncing contacts from ERPNext: add a scheduled job in the backend that pulls
  Customer/Lead phone numbers via the ERPNext REST API and calls `upsertContact`.
