# WhatsApp Cloud API Console

A self-hosted frontend for the official WhatsApp Business Cloud API (Meta Graph API) —
inbox, template management, and broadcast sending. Talks to `graph.facebook.com` directly,
no third-party wrapper.

## ⚠️ Security — read this before deploying

**Every route in this app is open with no login unless you set `BASIC_AUTH_USER` and
`BASIC_AUTH_PASS`.** If you deploy this on a public domain (which Coolify gives you by
default) without setting them, anyone who finds the URL can read every customer
conversation and phone number, send broadcasts using your business's WhatsApp number,
and delete your contacts and templates. There is no other access control.

Set both env vars — pick any username and a strong password — and the whole app requires
a login (your browser will prompt for it natively). This doesn't happen automatically on
upgrade to avoid breaking an existing deployment silently, but the server logs a loud
warning on every startup until you do.

Also set `META_APP_SECRET` (App Dashboard > Settings > Basic) so inbound webhook requests
are verified as actually coming from Meta, not a fabricated payload someone else could
POST to your webhook URL. Same deal — optional but strongly recommended, and warned about
loudly if missing.

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
7. **Confirm your WABA is actually subscribed to your app** — this is separate
   from webhook URL verification and is the single most common cause of
   status updates (sent/delivered/read/failed) silently never arriving even
   though everything else looks correctly configured:
   ```bash
   curl "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>"
   ```
   If the response doesn't list your app, subscribe it:
   ```bash
   curl -X POST "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>"
   ```
   Without this, the app can still *send* messages and receive inbound ones,
   but delivery/read/failure confirmations for outbound messages may never
   reach your webhook — meaning the whole accuracy system described below
   would have no data to work with, even though nothing looks broken.

## How message status accuracy actually works

This is worth understanding precisely, because it shapes what "sent" can and
can't mean in this app.

**There is no synchronous way to confirm delivery.** When you send a message,
Meta's API returns a 200 with a message ID (`wamid`) — that only means Meta
*accepted the request*. It says nothing about whether the message reached the
recipient. Real delivery status only ever arrives later, asynchronously, as a
separate webhook event. This is a property of the platform itself, not a
limitation of this app — no WhatsApp integration, however well-built, can give
you instant delivery confirmation.

**What this app does with that constraint**, since "accurate" has to mean
"eventually accurate, and never silently wrong" rather than "instant":

- The moment a send is accepted, it's recorded as **`queued`** — deliberately
  not "sent", to avoid implying delivery that hasn't happened yet.
- Every subsequent status webhook (`sent` → `delivered` → `read`, or `failed`)
  updates that record — in the message itself, in the broadcast job's counts,
  and in the contact's status badge.
- **Critically, a message that was initially accepted can still fail later.**
  Error `131026` ("Message Undeliverable" — Meta deliberately won't say why,
  for recipient privacy: could be blocked, not on WhatsApp, restricted
  country, etc.) and `131049` (a *per-recipient* cap on marketing messages
  from all businesses combined, not something specific to your account) both
  commonly arrive as a `failed` webhook *after* the request was already
  accepted. This app reconciles that: a recipient already counted as sent
  gets flipped to failed, the job's tallies adjust to match, and the
  contact's badge updates — so an async failure never gets silently lost.
- Broadcast progress keeps polling for about 2 minutes after the send loop
  itself finishes, specifically to catch these late-arriving confirmations.
- `read` will legitimately never arrive for many recipients — it depends on
  their read-receipts privacy setting being on. Its absence is not a signal
  of anything; only `failed` (with a reason attached) means something went wrong.

**Status vocabulary used throughout the app**: `queued` (accepted, unconfirmed)
→ `sent` (confirmed in transit) → `delivered` → `read`, or `failed` (with
Meta's specific error attached) at any point. The Contacts badge collapses
this to `queued` / `confirmed` (delivered or read) / `failed` for a quick
glance; click it for the full per-attempt history.

### Meta's failsafes that can block sends even when your code is correct

- **Messaging limits** are tiered — 250 (new/unverified) → 2,000 → 10,000 →
  100,000 → higher — and set at the *business portfolio* level, shared across
  every phone number in it, not per-number. They only count
  business-*initiated* conversations (a template sent to someone outside
  their 24h service window); replying within an open window is unlimited.
  Check your current tier:
  ```bash
  curl "https://graph.facebook.com/v23.0/<PHONE_NUMBER_ID>?fields=whatsapp_business_manager_messaging_limit" \
    -H "Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>"
  ```
- **Quality rating** (Green/Yellow/Red, driven by block/report rates,
  recency-weighted) gates tier upgrades and can trigger a *downgrade* if it
  stays Red/Low for 7 days straight. A large broadcast to a poorly-targeted
  or stale list is the most common way to tank it.
- **Auto-scaling** happens automatically — meet ~50% utilization of your
  current limit over 7 days while keeping quality good, and Meta upgrades you
  within about 6 hours. No action needed on your end beyond sending
  legitimately engaged traffic.
- **Don't retry `131026`/`131049` immediately** — Meta's own guidance is that
  an immediate retry just reproduces the same failure; space retries out with
  increasing intervals instead. The Retry button in this app does an
  immediate retry, which is right for most failure causes (a transient error,
  a since-fixed template) but not ideal specifically for these two codes if
  they recur repeatedly for the same recipient.
- **Rate/throughput limits** (`4`, `80007`, `130429`, `131056`) are about
  *speed*, not the daily cap — sending too fast. The 200ms delay between
  broadcast sends in this app already paces well under typical throughput
  limits for standard accounts.

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
- Every broadcast attempt is tracked through its *real* lifecycle via Meta's
  status webhooks (queued → sent → delivered/read, or failed with the actual
  reason) — not just whether the initial API call was accepted. See "How
  message status accuracy actually works" above for the full picture,
  including async failures that arrive after an initial success.
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
- **Note on media headers**: the sample file uploaded during template
  *creation* is only what Meta reviews the template against — every actual
  *send* using that template still needs its own header media supplied
  fresh (Meta's API requires this per-message, not just at creation time).
  Broadcast handles this: selecting a template with a media header prompts
  for a file upload before you can send, and it's included correctly in
  every request (this was previously missing entirely and caused error
  `#132012 Parameter format does not match format in the created template`
  on any send using a media-header template).

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
- **Blank template variables**: if a broadcast recipient's mapped value is empty
  (e.g. a contact has no Company on file and a variable is mapped to Company),
  Meta rejects that specific send with `#131008 Required parameter is missing`
  — an empty string isn't treated as a valid substitute for `{{n}}`. The preview
  table highlights any blank cell in red, warns with a count, and blocks sending
  until you either fill them in or exclude those rows with one click.
- **Broadcast pacing**: sends are sequential with a small delay (see `delay_ms` in
  `backend/src/routes/broadcast.js`), running as a background job rather than
  holding an HTTP request open — this already handles thousands of recipients
  without timing out (see Broadcast scheduling above). For very high volume you
  may still want a proper job queue (e.g. BullMQ) for retry/backoff sophistication
  beyond what's here, but it isn't required for correctness at typical business scale.
- **Webhook reliability**: Meta may redeliver the same webhook event (e.g. if this
  server doesn't ack fast enough). Inbound messages are deduplicated by `wamid`
  before insertion, so a redelivery doesn't create a duplicate message in the Inbox.
- **Request size**: the JSON body limit is set to 25MB (Express defaults to 100KB),
  since a bulk broadcast or contact import with a few thousand rows of personalization
  data comfortably exceeds the default and would otherwise fail with a silent 413.
- **Media header expiry risk**: a template header's uploaded media (image/video/PDF)
  is sent to Meta at compose time, not at actual-send time. This is a non-issue for
  an immediate broadcast, but for a *scheduled* broadcast — or a *retry* of a
  media-header job run much later — Meta doesn't guarantee the uploaded media stays
  valid indefinitely. The UI warns about this in both places; there's no way to
  fully eliminate the risk in code since it depends on Meta's media retention window.

## Known limitations

- **Switching tabs loses in-progress state.** Each tab (Inbox/Contacts/Templates/
  Broadcast) fully unmounts when you navigate away, so an unsaved form, a built-up
  recipient selection in Broadcast, etc. resets if you click to another tab and
  back. Fixing this properly means either lifting significant state up to `App.jsx`
  or changing how tabs render (keep-alive style), both of which carry real risk of
  layout regressions for a fairly low-frequency annoyance — flagging it here rather
  than rushing a fix that could break something else.
- **Template list pagination**: `listTemplates()` fetches up to 200 templates in one
  call with no pagination follow-up. Fine for a normal-sized template library; would
  need `paging.next` handling if you ever exceed 200 templates on one WABA.

## Extending

- Media messages (image/document/video): already implemented for chat sends —
  see `backend/src/routes/send.js` and the attach button in the Inbox.
- Syncing contacts from ERPNext: add a scheduled job in the backend that pulls
  Customer/Lead phone numbers via the ERPNext REST API and calls `upsertContact`.
