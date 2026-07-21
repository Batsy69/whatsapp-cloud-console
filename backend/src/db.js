import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "data.sqlite"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  wa_id TEXT PRIMARY KEY,
  name TEXT,
  last_message_at INTEGER,
  window_expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL,
  wamid TEXT,
  direction TEXT NOT NULL,        -- 'inbound' | 'outbound'
  type TEXT NOT NULL,             -- 'text' | 'template' | 'image' | etc.
  body TEXT,                      -- display text
  template_name TEXT,
  status TEXT,                    -- for outbound: sent/delivered/read/failed
  timestamp INTEGER NOT NULL,
  raw TEXT                        -- original payload, for debugging
);

CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id, timestamp);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS broadcast_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_name TEXT NOT NULL,
  language_code TEXT NOT NULL,
  shared_components TEXT,   -- JSON: components applied to every recipient unless overridden
  total INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',  -- 'scheduled' | 'running' | 'completed'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  wa_id TEXT NOT NULL,
  variables TEXT,           -- JSON: per-recipient variable overrides (from CSV or directory fields)
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed'
  wamid TEXT,
  error TEXT,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_job ON broadcast_recipients(job_id, status);
`);

// Additive migration guard - safe to re-run, needed for anyone upgrading
// from an earlier version of this schema.
for (const stmt of [
  "ALTER TABLE messages ADD COLUMN media_id TEXT",
  "ALTER TABLE messages ADD COLUMN mime_type TEXT",
  "ALTER TABLE messages ADD COLUMN latitude REAL",
  "ALTER TABLE messages ADD COLUMN longitude REAL",
  "ALTER TABLE contacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE contacts ADD COLUMN company TEXT",
  "ALTER TABLE contacts ADD COLUMN city TEXT",
  "ALTER TABLE contacts ADD COLUMN state TEXT",
  "ALTER TABLE contacts ADD COLUMN email TEXT",
  "ALTER TABLE contacts ADD COLUMN custom_fields TEXT",
  "ALTER TABLE contacts ADD COLUMN group_id INTEGER",
  "ALTER TABLE broadcast_jobs ADD COLUMN scheduled_at INTEGER",
  "ALTER TABLE contacts ADD COLUMN last_broadcast_status TEXT",
  "ALTER TABLE contacts ADD COLUMN last_broadcast_error TEXT",
  "ALTER TABLE contacts ADD COLUMN last_broadcast_template TEXT",
  "ALTER TABLE contacts ADD COLUMN last_broadcast_at INTEGER",
  "ALTER TABLE broadcast_recipients ADD COLUMN updated_at INTEGER",
]) {
  try {
    db.exec(stmt);
  } catch {
    /* column already exists */
  }
}

// Only safe to create after the migration loop above, since it references a
// column (updated_at) that only exists on older databases once that loop adds it.
db.exec("CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_wa_id ON broadcast_recipients(wa_id, updated_at)");

// --- Contacts (conversation state + directory fields share one row per wa_id) ---

export function upsertContact(waId, name) {
  const now = Date.now();
  const row = db.prepare("SELECT wa_id FROM contacts WHERE wa_id = ?").get(waId);
  if (row) {
    db.prepare(
      "UPDATE contacts SET name = COALESCE(?, name), last_message_at = ?, window_expires_at = ?, archived = 0 WHERE wa_id = ?"
    ).run(name || null, now, now + 24 * 60 * 60 * 1000, waId);
  } else {
    db.prepare(
      "INSERT INTO contacts (wa_id, name, last_message_at, window_expires_at) VALUES (?, ?, ?, ?)"
    ).run(waId, name || waId, now, now + 24 * 60 * 60 * 1000);
  }
}

export function touchOutbound(waId) {
  // An outbound message does NOT reopen the 24h window - only inbound does.
  // We still bump last activity so the conversation sorts to the top.
  db.prepare("UPDATE contacts SET last_message_at = ? WHERE wa_id = ?").run(Date.now(), waId);
}

export function archiveContact(waId, archived) {
  db.prepare("UPDATE contacts SET archived = ? WHERE wa_id = ?").run(archived ? 1 : 0, waId);
}

export function deleteConversation(waId) {
  const tx = db.transaction((id) => {
    db.prepare("DELETE FROM messages WHERE wa_id = ?").run(id);
    db.prepare("DELETE FROM contacts WHERE wa_id = ?").run(id);
  });
  tx(waId);
}

// Directory-style upsert: only overwrites fields that are actually provided,
// so a CSV import that only has phone+company doesn't null out an existing
// email, and so this is safe to call for both "add new" and "enrich existing".
// Unlike upsertContact (which marks a live 24h window), a brand-new row
// created here has no messaging activity yet, so the window stays closed
// until the contact actually messages in.
export function upsertDirectoryContact({ wa_id, name, company, city, state, email, custom_fields, group_id }) {
  const customJson = custom_fields ? JSON.stringify(custom_fields) : null;
  const existing = db.prepare("SELECT wa_id FROM contacts WHERE wa_id = ?").get(wa_id);
  if (existing) {
    db.prepare(
      `UPDATE contacts SET
        name = COALESCE(?, name), company = COALESCE(?, company), city = COALESCE(?, city),
        state = COALESCE(?, state), email = COALESCE(?, email),
        custom_fields = COALESCE(?, custom_fields), group_id = COALESCE(?, group_id)
       WHERE wa_id = ?`
    ).run(name || null, company || null, city || null, state || null, email || null, customJson, group_id || null, wa_id);
  } else {
    db.prepare(
      `INSERT INTO contacts (wa_id, name, company, city, state, email, custom_fields, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(wa_id, name || wa_id, company || null, city || null, state || null, email || null, customJson, group_id || null);
  }
}

// Records the outcome of the most recent broadcast attempt directly on the
// contact, so a failure stays visible wherever that contact shows up (not
// just buried in one job's history) and self-clears the moment a later send
// to them succeeds. Creates a bare contact row if one doesn't exist yet,
// since a failed send to a brand-new number should still surface somewhere.
export function recordBroadcastResult(waId, { status, error, template }) {
  const existing = db.prepare("SELECT wa_id FROM contacts WHERE wa_id = ?").get(waId);
  if (!existing) {
    db.prepare("INSERT INTO contacts (wa_id, name) VALUES (?, ?)").run(waId, waId);
  }
  db.prepare(
    "UPDATE contacts SET last_broadcast_status = ?, last_broadcast_error = ?, last_broadcast_template = ?, last_broadcast_at = ? WHERE wa_id = ?"
  ).run(status, error || null, template, Date.now(), waId);
}

export function listDirectory(groupId, failedOnly) {
  const where = [];
  const params = [];
  if (groupId) { where.push("c.group_id = ?"); params.push(groupId); }
  if (failedOnly) where.push("c.last_broadcast_status = 'failed'");
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT c.wa_id, c.name, c.company, c.city, c.state, c.email, c.custom_fields,
              c.group_id, g.name AS group_name, c.last_message_at, c.archived,
              c.last_broadcast_status, c.last_broadcast_error, c.last_broadcast_template, c.last_broadcast_at
       FROM contacts c
       LEFT JOIN groups g ON g.id = c.group_id
       ${whereClause}
       ORDER BY c.name COLLATE NOCASE`
    )
    .all(...params);
}

const insertStmt = db.prepare(
  `INSERT INTO messages
    (wa_id, wamid, direction, type, body, template_name, status, timestamp, raw, media_id, mime_type, latitude, longitude)
   VALUES
    (@wa_id, @wamid, @direction, @type, @body, @template_name, @status, @timestamp, @raw, @media_id, @mime_type, @latitude, @longitude)`
);

export function insertMessage(msg) {
  insertStmt.run({
    media_id: null,
    mime_type: null,
    latitude: null,
    longitude: null,
    ...msg,
  });
}

export function updateMessageStatus(wamid, status) {
  db.prepare("UPDATE messages SET status = ? WHERE wamid = ?").run(status, wamid);
}

// Meta documents that webhook events may be redelivered (e.g. if we don't
// ack fast enough). Without this check, a redelivered inbound message would
// get inserted twice and show up as a duplicate in the Inbox thread.
export function messageExistsByWamid(wamid) {
  return !!db.prepare("SELECT 1 FROM messages WHERE wamid = ? LIMIT 1").get(wamid);
}

export function getLatestInboundWamid(waId) {
  return db
    .prepare(
      "SELECT wamid FROM messages WHERE wa_id = ? AND direction = 'inbound' ORDER BY timestamp DESC LIMIT 1"
    )
    .get(waId)?.wamid;
}

export function listConversations(includeArchived = false) {
  return db
    .prepare(
      `SELECT c.wa_id, c.name, c.last_message_at, c.window_expires_at, c.archived,
              (SELECT body FROM messages m WHERE m.wa_id = c.wa_id ORDER BY m.timestamp DESC LIMIT 1) AS last_body
       FROM contacts c
       WHERE c.archived = ? AND c.last_message_at IS NOT NULL
       ORDER BY c.last_message_at DESC`
    )
    .all(includeArchived ? 1 : 0);
}

export function listMessages(waId) {
  return db.prepare("SELECT * FROM messages WHERE wa_id = ? ORDER BY timestamp ASC").all(waId);
}

export function getContact(waId) {
  return db.prepare("SELECT * FROM contacts WHERE wa_id = ?").get(waId);
}

// --- Groups ---

export function listGroups() {
  return db
    .prepare(
      `SELECT g.id, g.name, g.created_at, COUNT(c.wa_id) AS contact_count
       FROM groups g LEFT JOIN contacts c ON c.group_id = g.id
       GROUP BY g.id ORDER BY g.name COLLATE NOCASE`
    )
    .all();
}

export function createGroup(name) {
  const existing = db.prepare("SELECT id FROM groups WHERE name = ?").get(name);
  if (existing) return existing.id;
  const result = db.prepare("INSERT INTO groups (name, created_at) VALUES (?, ?)").run(name, Date.now());
  return result.lastInsertRowid;
}

export function deleteGroup(id) {
  const tx = db.transaction((gid) => {
    db.prepare("UPDATE contacts SET group_id = NULL WHERE group_id = ?").run(gid);
    db.prepare("DELETE FROM groups WHERE id = ?").run(gid);
  });
  tx(id);
}

// --- Broadcast jobs (bulk sends, processed async in the background) ---

export function createBroadcastJob({ template_name, language_code, shared_components, total, scheduled_at }) {
  const status = scheduled_at && scheduled_at > Date.now() ? "scheduled" : "running";
  const result = db
    .prepare(
      `INSERT INTO broadcast_jobs (template_name, language_code, shared_components, total, created_at, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(template_name, language_code, JSON.stringify(shared_components || []), total, Date.now(), scheduled_at || null, status);
  return { id: result.lastInsertRowid, status };
}

const insertRecipientStmt = db.prepare(
  `INSERT INTO broadcast_recipients (job_id, wa_id, variables) VALUES (?, ?, ?)`
);

export function insertBroadcastRecipients(jobId, rows) {
  const tx = db.transaction((items) => {
    for (const r of items) {
      insertRecipientStmt.run(jobId, r.wa_id, r.variables ? JSON.stringify(r.variables) : null);
    }
  });
  tx(rows);
}

export function getPendingRecipients(jobId, limit = 500) {
  return db
    .prepare("SELECT * FROM broadcast_recipients WHERE job_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?")
    .all(jobId, limit);
}

export function updateRecipientResult(id, { status, wamid, error }) {
  db.prepare("UPDATE broadcast_recipients SET status = ?, wamid = ?, error = ?, updated_at = ? WHERE id = ?").run(
    status,
    wamid || null,
    error || null,
    Date.now(),
    id
  );
}

export function bumpJobCounts(jobId, { sentDelta = 0, failedDelta = 0 }) {
  db.prepare("UPDATE broadcast_jobs SET sent = sent + ?, failed = failed + ? WHERE id = ?").run(
    sentDelta,
    failedDelta,
    jobId
  );
}

export function markJobRunning(jobId) {
  db.prepare("UPDATE broadcast_jobs SET status = 'running' WHERE id = ?").run(jobId);
}

export function markJobCompleted(jobId) {
  db.prepare("UPDATE broadcast_jobs SET status = 'completed' WHERE id = ?").run(jobId);
}

export function cancelScheduledJob(jobId) {
  const tx = db.transaction((id) => {
    const info = db.prepare("DELETE FROM broadcast_jobs WHERE id = ? AND status = 'scheduled'").run(id);
    if (info.changes > 0) db.prepare("DELETE FROM broadcast_recipients WHERE job_id = ?").run(id);
    return info.changes > 0;
  });
  return tx(jobId);
}

export function listBroadcastJobs(limit = 20) {
  return db.prepare("SELECT * FROM broadcast_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function getBroadcastJob(jobId) {
  return db.prepare("SELECT * FROM broadcast_jobs WHERE id = ?").get(jobId);
}

export function getFailedRecipients(jobId, limit = 200) {
  return db
    .prepare("SELECT wa_id, error FROM broadcast_recipients WHERE job_id = ? AND status = 'failed' LIMIT ?")
    .all(jobId, limit);
}

// Full failed-recipient rows (with their original variables) for retrying a
// job - no limit, since a retry needs every failure, not just a preview slice.
export function getFailedRecipientsFull(jobId) {
  return db
    .prepare("SELECT wa_id, variables FROM broadcast_recipients WHERE job_id = ? AND status = 'failed'")
    .all(jobId);
}

export function getAllRecipients(jobId) {
  return db.prepare("SELECT wa_id, status, wamid, error FROM broadcast_recipients WHERE job_id = ?").all(jobId);
}

// Full history of every broadcast attempt to one contact, across every job
// ever sent - this is what answers "did campaign X actually reach them",
// which the single last_broadcast_status field on the contact can't (it
// only ever holds the *most recent* attempt, overwritten on each send).
export function getContactBroadcastHistory(waId, limit = 50) {
  return db
    .prepare(
      `SELECT br.job_id, br.status, br.error, br.wamid, br.updated_at, bj.template_name
       FROM broadcast_recipients br
       JOIN broadcast_jobs bj ON bj.id = br.job_id
       WHERE br.wa_id = ?
       ORDER BY br.updated_at DESC, br.id DESC
       LIMIT ?`
    )
    .all(waId, limit);
}

// Jobs interrupted mid-send (e.g. a redeploy) - resumed once at startup.
export function getUnfinishedJobs() {
  return db.prepare("SELECT id FROM broadcast_jobs WHERE status = 'running'").all();
}

// Scheduled jobs whose time has arrived - checked periodically, and once at
// startup to catch anything that came due while the server was down.
export function getDueScheduledJobs() {
  return db.prepare("SELECT id FROM broadcast_jobs WHERE status = 'scheduled' AND scheduled_at <= ?").all(Date.now());
}

export default db;
