import { Router } from "express";
import { sendTemplateMessage } from "../graphApi.js";
import {
  insertMessage,
  touchOutbound,
  upsertContact,
  createBroadcastJob,
  insertBroadcastRecipients,
  getPendingRecipients,
  updateRecipientResult,
  bumpJobCounts,
  markJobRunning,
  markJobCompleted,
  cancelScheduledJob,
  listBroadcastJobs,
  getBroadcastJob,
  getFailedRecipients,
  getAllRecipients,
  getUnfinishedJobs,
  getDueScheduledJobs,
} from "../db.js";
import { normalizePhone } from "../phone.js";

const router = Router();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A recipient's own `variables` (from a CSV column, or resolved from their
// saved directory fields when broadcasting to a group) override the shared
// BODY component's parameters for that one send, leaving any shared
// HEADER/BUTTON components untouched.
function mergeComponents(sharedComponents, recipientVariables) {
  if (!recipientVariables) return sharedComponents;
  const bodyParams = recipientVariables.map((v) => ({ type: "text", text: String(v ?? "") }));
  let replaced = false;
  const merged = (sharedComponents || []).map((c) => {
    if (c.type === "body") {
      replaced = true;
      return { type: "body", parameters: bodyParams };
    }
    return c;
  });
  if (!replaced) merged.push({ type: "body", parameters: bodyParams });
  return merged;
}

async function processJob(jobId, templateName, languageCode, sharedComponents, delayMs) {
  // Pull in batches rather than loading thousands of rows into memory at
  // once, and rather than blocking the HTTP response that started this job.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = getPendingRecipients(jobId, 500);
    if (batch.length === 0) break;

    for (const r of batch) {
      const variables = r.variables ? JSON.parse(r.variables) : null;
      const components = mergeComponents(sharedComponents, variables);
      try {
        const result = await sendTemplateMessage(r.wa_id, templateName, languageCode, components);
        const wamid = result?.messages?.[0]?.id || null;
        updateRecipientResult(r.id, { status: "sent", wamid });
        bumpJobCounts(jobId, { sentDelta: 1 });

        // Auto-saves the recipient into the contact directory - this is
        // what makes numbers show up in the Contacts tab automatically
        // after any broadcast, without a separate import step.
        upsertContact(r.wa_id, null);
        insertMessage({
          wa_id: r.wa_id,
          wamid,
          direction: "outbound",
          type: "template",
          body: `[broadcast: ${templateName}]`,
          template_name: templateName,
          status: "sent",
          timestamp: Date.now(),
          raw: JSON.stringify(result),
        });
        touchOutbound(r.wa_id);
      } catch (err) {
        updateRecipientResult(r.id, { status: "failed", error: err.message });
        bumpJobCounts(jobId, { failedDelta: 1 });
      }
      await sleep(delayMs);
    }
  }
  markJobCompleted(jobId);
}

router.post("/", (req, res) => {
  const { template_name, language_code, recipients, components, delay_ms = 200, scheduled_at } = req.body;

  if (!template_name || !language_code || !Array.isArray(recipients) || recipients.length === 0) {
    return res
      .status(400)
      .json({ error: "template_name, language_code, and a non-empty recipients array are required" });
  }

  // Normalize + dedupe, since a CSV of "thousands of numbers" is exactly
  // where duplicate/malformed entries are most likely to sneak in.
  const seen = new Set();
  const rows = [];
  for (const r of recipients) {
    const wa_id = normalizePhone(typeof r === "string" ? r : r.wa_id);
    if (!wa_id || seen.has(wa_id)) continue;
    seen.add(wa_id);
    rows.push({ wa_id, variables: typeof r === "object" ? r.variables : undefined });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: "No valid recipients after normalization/dedup" });
  }

  const scheduledAtMs = scheduled_at ? new Date(scheduled_at).getTime() : null;
  if (scheduled_at && Number.isNaN(scheduledAtMs)) {
    return res.status(400).json({ error: "scheduled_at is not a valid date" });
  }

  const { id: jobId, status } = createBroadcastJob({
    template_name,
    language_code,
    shared_components: components || [],
    total: rows.length,
    scheduled_at: scheduledAtMs,
  });
  insertBroadcastRecipients(jobId, rows);

  if (status === "running") {
    // Fire-and-forget: respond immediately with the job id so the frontend
    // can poll progress, instead of holding one HTTP request open for
    // however long thousands of throttled sends take.
    processJob(jobId, template_name, language_code, components || [], delay_ms).catch((err) =>
      console.error(`Broadcast job ${jobId} crashed:`, err)
    );
  }
  // If scheduled, the periodic checker below picks it up when due - nothing
  // more to do here.

  res.json({ job_id: jobId, total: rows.length, status, scheduled_at: scheduledAtMs });
});

router.get("/jobs", (req, res) => {
  res.json(listBroadcastJobs());
});

router.get("/jobs/:id", (req, res) => {
  const job = getBroadcastJob(req.params.id);
  if (!job) return res.sendStatus(404);
  res.json({ ...job, recent_failures: getFailedRecipients(req.params.id, 50) });
});

router.delete("/jobs/:id", (req, res) => {
  const cancelled = cancelScheduledJob(req.params.id);
  if (!cancelled) return res.status(409).json({ error: "Job is not in a cancellable (scheduled) state" });
  res.json({ ok: true });
});

router.get("/jobs/:id/export", (req, res) => {
  const job = getBroadcastJob(req.params.id);
  if (!job) return res.sendStatus(404);
  const rows = getAllRecipients(req.params.id);
  const csv = [
    "wa_id,status,wamid,error",
    ...rows.map((r) => [r.wa_id, r.status, r.wamid || "", (r.error || "").replace(/[\n,]/g, " ")].join(",")),
  ].join("\n");
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", `attachment; filename="broadcast-${req.params.id}.csv"`);
  res.send(csv);
});

function launchDueJobs() {
  for (const { id } of getDueScheduledJobs()) {
    const job = getBroadcastJob(id);
    if (!job) continue;
    markJobRunning(id);
    const shared = JSON.parse(job.shared_components || "[]");
    console.log(`Starting scheduled broadcast job ${id} (${job.template_name})`);
    processJob(id, job.template_name, job.language_code, shared, 200).catch((err) =>
      console.error(`Scheduled broadcast job ${id} crashed:`, err)
    );
  }
}

// Called once at server startup - resumes any job left "running" from a
// process that was interrupted mid-send (e.g. a redeploy), and immediately
// checks for scheduled jobs whose time already passed while the server was
// down. Then starts a periodic check for jobs that come due while running.
export function resumeUnfinishedJobs() {
  for (const { id } of getUnfinishedJobs()) {
    const job = getBroadcastJob(id);
    if (!job) continue;
    const shared = JSON.parse(job.shared_components || "[]");
    console.log(`Resuming interrupted broadcast job ${id} (${job.template_name})`);
    processJob(id, job.template_name, job.language_code, shared, 200).catch((err) =>
      console.error(`Resumed broadcast job ${id} crashed:`, err)
    );
  }
  launchDueJobs();
  setInterval(launchDueJobs, 30_000);
}

export default router;
