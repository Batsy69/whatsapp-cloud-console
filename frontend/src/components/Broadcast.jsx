import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";

const PAGE_SIZE = 50;

function varCount(text) {
  return new Set((text || "").match(/\{\{\d+\}\}/g) || []).size;
}

function analyzeTemplate(t) {
  const header = t?.components?.find((c) => c.type === "HEADER");
  const body = t?.components?.find((c) => c.type === "BODY");
  const footer = t?.components?.find((c) => c.type === "FOOTER");
  const buttonsComp = t?.components?.find((c) => c.type === "BUTTONS");
  const dynamicUrlButtonIndex = (buttonsComp?.buttons || []).findIndex(
    (b) => b.type === "URL" && /\{\{\d+\}\}/.test(b.url || "")
  );
  return {
    headerIsText: header?.format === "TEXT",
    headerVarCount: header?.format === "TEXT" ? varCount(header.text) : 0,
    bodyVarCount: varCount(body?.text),
    footerText: footer?.text,
    buttons: buttonsComp?.buttons || [],
    dynamicUrlButtonIndex,
  };
}

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { cells.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseCsvFile(text) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim().length > 0).map(parseCsvLine);
  if (rows.length === 0) return [];
  const dataRows = /[a-zA-Z]/.test(rows[0][0] || "") ? rows.slice(1) : rows;
  return dataRows
    .map((row) => {
      const [wa_id, ...vars] = row;
      const hasVars = vars.length > 0 && vars.some((v) => v !== "");
      return { wa_id, variables: hasVars ? vars : undefined };
    })
    .filter((r) => r.wa_id);
}

function resolveField(contact, key) {
  if (!key) return "";
  if (key.startsWith("custom:")) return contact.custom_fields?.[key.slice(7)] ?? "";
  return contact[key] ?? "";
}

// Mirrors the backend's normalizePhone default (country code 91) closely
// enough for an accurate preview/dedupe pass. The server re-normalizes and
// dedupes again at send time regardless, so this is display-only, not the
// source of truth.
function previewNormalize(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  return digits.length === 10 ? "91" + digits : digits;
}

function ProgressPanel({ job, onExport, onCancel }) {
  if (!job) return <div style={{ fontSize: 13, color: "var(--text-soft)" }}>No broadcast selected yet.</div>;

  if (job.status === "scheduled") {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 10 }}>
          <span>{job.template_name}</span>
          <span className="status-pill PENDING">scheduled</span>
        </div>
        <div style={{ fontSize: 13, marginBottom: 14 }}>
          Sending to {job.total} recipient(s) at{" "}
          <strong>{new Date(job.scheduled_at).toLocaleString()}</strong>
        </div>
        <button className="btn-danger" onClick={() => onCancel(job.id)}>Cancel scheduled broadcast</button>
      </>
    );
  }

  const done = job.sent + job.failed;
  const pct = job.total ? Math.round((done / job.total) * 100) : 0;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 6 }}>
        <span>{job.template_name}</span>
        <span className={`status-pill ${job.status === "completed" ? "APPROVED" : "PENDING"}`}>
          {job.status === "completed" ? "done" : "sending…"}
        </span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div style={{ display: "flex", gap: 16, fontSize: 12.5, margin: "8px 0 14px", fontFamily: "var(--mono)" }}>
        <span>{done} / {job.total} processed</span>
        <span style={{ color: "var(--accent)" }}>{job.sent} sent</span>
        {job.failed > 0 && <span style={{ color: "var(--danger)" }}>{job.failed} failed</span>}
      </div>
      {job.recent_failures?.length > 0 && (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--text-soft)", marginBottom: 6 }}>
            Recent failures
          </div>
          {job.recent_failures.map((f, i) => (
            <div key={i} className="result-row fail">
              <span>{f.wa_id}</span>
              <span>{f.error}</span>
            </div>
          ))}
        </>
      )}
      {job.status === "completed" && (
        <button className="btn-danger" style={{ marginTop: 12, borderColor: "var(--line)", color: "var(--text-soft)" }} onClick={() => onExport(job.id)}>
          Download full results (CSV)
        </button>
      )}
    </>
  );
}

export default function Broadcast({ prefill, onConsumePrefill }) {
  const [templates, setTemplates] = useState([]);
  const [templateName, setTemplateName] = useState("");
  const [headerVars, setHeaderVars] = useState([]);
  const [bodyVars, setBodyVars] = useState([]);
  const [buttonVar, setButtonVar] = useState("");
  const [recipientsText, setRecipientsText] = useState("");
  const [csvRows, setCsvRows] = useState([]);
  const [csvFileName, setCsvFileName] = useState("");
  const [groupContacts, setGroupContacts] = useState([]);
  const [groupLabel, setGroupLabel] = useState("");
  const [fieldMapping, setFieldMapping] = useState([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const [history, setHistory] = useState([]);
  const fileInputRef = useRef(null);

  // --- Preview/review step ---
  const [previewMode, setPreviewMode] = useState(false);
  const [previewRows, setPreviewRows] = useState([]);
  const [previewPage, setPreviewPage] = useState(0);
  const [bulkVarInputs, setBulkVarInputs] = useState([]);

  useEffect(() => {
    api.getTemplates().then((t) => setTemplates(t.filter((x) => x.status === "APPROVED")));
    refreshHistory();
  }, []);

  useEffect(() => {
    if (prefill) {
      setGroupContacts(prefill.recipients);
      setGroupLabel(prefill.label);
      setCsvRows([]);
      setCsvFileName("");
      setRecipientsText("");
      onConsumePrefill();
    }
  }, [prefill]);

  async function refreshHistory() {
    setHistory(await api.getBroadcastJobs());
  }

  const selected = useMemo(() => templates.find((t) => t.name === templateName), [templates, templateName]);
  const analysis = useMemo(() => (selected ? analyzeTemplate(selected) : null), [selected]);

  const customFieldKeys = useMemo(() => {
    const keys = new Set();
    groupContacts.forEach((c) => c.custom_fields && Object.keys(c.custom_fields).forEach((k) => keys.add(k)));
    return [...keys];
  }, [groupContacts]);

  function handleSelectTemplate(name) {
    setTemplateName(name);
    const t = templates.find((x) => x.name === name);
    const a = t ? analyzeTemplate(t) : null;
    setHeaderVars(new Array(a?.headerVarCount || 0).fill(""));
    setBodyVars(new Array(a?.bodyVarCount || 0).fill(""));
    setFieldMapping(new Array(a?.bodyVarCount || 0).fill(""));
    setButtonVar("");
  }

  function handleCsvFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsvRows(parseCsvFile(String(reader.result)));
      setCsvFileName(file.name);
      setRecipientsText("");
      setGroupContacts([]);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function clearRecipientSource() {
    setCsvRows([]);
    setCsvFileName("");
    setGroupContacts([]);
    setGroupLabel("");
  }

  const textRecipients = useMemo(
    () => recipientsText.split(/[\n,]/).map((r) => r.trim()).filter(Boolean).map((wa_id) => ({ wa_id })),
    [recipientsText]
  );

  const recipientCount = groupContacts.length > 0 ? groupContacts.length : csvRows.length > 0 ? csvRows.length : textRecipients.length;

  // --- Build the editable preview table from whatever source is active ---
  function handleBuildPreview() {
    const bodyVarCount = analysis?.bodyVarCount || 0;
    let rows;

    if (groupContacts.length > 0) {
      const hasMapping = fieldMapping.some((f) => f);
      rows = groupContacts.map((c) => ({
        wa_id: c.wa_id,
        label: c.name || c.wa_id,
        variables: Array.from({ length: bodyVarCount }, (_, i) =>
          hasMapping && fieldMapping[i] ? resolveField(c, fieldMapping[i]) : bodyVars[i] || ""
        ),
      }));
    } else if (csvRows.length > 0) {
      rows = csvRows.map((r) => ({
        wa_id: r.wa_id,
        label: r.wa_id,
        variables: Array.from({ length: bodyVarCount }, (_, i) => r.variables?.[i] ?? bodyVars[i] ?? ""),
      }));
    } else {
      rows = textRecipients.map((r) => ({
        wa_id: r.wa_id,
        label: r.wa_id,
        variables: Array.from({ length: bodyVarCount }, (_, i) => bodyVars[i] || ""),
      }));
    }

    // De-dupe in the preview too, so what you review matches what actually sends.
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      const key = previewNormalize(r.wa_id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...r, wa_id: key, included: true });
    }

    setPreviewRows(deduped);
    setBulkVarInputs(new Array(bodyVarCount).fill(""));
    setPreviewPage(0);
    setPreviewMode(true);
  }

  function backToEdit() {
    setPreviewMode(false);
  }

  function toggleIncluded(globalIndex) {
    setPreviewRows((prev) => prev.map((r, i) => (i === globalIndex ? { ...r, included: !r.included } : r)));
  }
  function setAllIncluded(val) {
    setPreviewRows((prev) => prev.map((r) => ({ ...r, included: val })));
  }
  function updatePreviewVar(globalIndex, varIndex, value) {
    setPreviewRows((prev) =>
      prev.map((r, i) => (i === globalIndex ? { ...r, variables: r.variables.map((v, j) => (j === varIndex ? value : v)) } : r))
    );
  }
  function updatePreviewPhone(globalIndex, value) {
    setPreviewRows((prev) => prev.map((r, i) => (i === globalIndex ? { ...r, wa_id: value.replace(/[^\d]/g, "") } : r)));
  }
  function applyBulkVar(varIndex) {
    const val = bulkVarInputs[varIndex];
    setPreviewRows((prev) => prev.map((r) => ({ ...r, variables: r.variables.map((v, j) => (j === varIndex ? val : v)) })));
  }

  const includedCount = previewRows.filter((r) => r.included).length;
  const totalPages = Math.max(1, Math.ceil(previewRows.length / PAGE_SIZE));
  const pageStart = previewPage * PAGE_SIZE;
  const pagedRows = previewRows.slice(pageStart, pageStart + PAGE_SIZE);

  // Poll the active job until it completes. Scheduled jobs are checked less
  // often since they may not fire for hours.
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let timer;
    async function poll() {
      try {
        const job = await api.getBroadcastJob(activeJobId);
        if (cancelled) return;
        setActiveJob(job);
        if (job.status !== "completed") {
          timer = setTimeout(poll, job.status === "scheduled" ? 15000 : 1500);
        } else {
          refreshHistory();
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    }
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeJobId]);

  async function handleConfirmSend() {
    if (!selected || includedCount === 0) return;
    setBusy(true);
    setError("");
    try {
      const components = [];
      if (analysis.headerVarCount) {
        components.push({ type: "header", parameters: headerVars.map((v) => ({ type: "text", text: v || "" })) });
      }
      if (analysis.dynamicUrlButtonIndex > -1) {
        components.push({
          type: "button",
          sub_type: "url",
          index: String(analysis.dynamicUrlButtonIndex),
          parameters: [{ type: "text", text: buttonVar || "" }],
        });
      }

      const recipients = previewRows
        .filter((r) => r.included)
        .map((r) => ({ wa_id: r.wa_id, variables: analysis.bodyVarCount > 0 ? r.variables : undefined }));

      const scheduled_at = scheduleEnabled && scheduleAt ? new Date(scheduleAt).toISOString() : undefined;

      const res = await api.startBroadcast({
        template_name: selected.name,
        language_code: selected.language,
        recipients,
        components,
        scheduled_at,
      });
      setActiveJobId(res.job_id);
      setActiveJob({
        id: res.job_id,
        template_name: selected.name,
        total: res.total,
        sent: 0,
        failed: 0,
        status: res.status,
        scheduled_at: res.scheduled_at,
        recent_failures: [],
      });
      setPreviewMode(false);
      refreshHistory();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(jobId) {
    try {
      await api.cancelBroadcastJob(jobId);
      setActiveJobId(null);
      setActiveJob(null);
      refreshHistory();
    } catch (e) {
      setError(e.message);
    }
  }

  function handleExport(jobId) {
    window.open(api.exportBroadcastJobUrl(jobId), "_blank");
  }

  const fieldOptions = ["", "name", "company", "city", "state", "email", ...customFieldKeys.map((k) => `custom:${k}`)];
  const fieldLabel = (key) => (key === "" ? "— shared default —" : key.startsWith("custom:") ? key.slice(7) : key);

  // --- Preview/review screen ---
  if (previewMode) {
    return (
      <div className="panel-view">
        {error && <div className="banner error">{error}</div>}
        <div className="preview-toolbar">
          <button className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} onClick={backToEdit}>
            ← Back to edit
          </button>
          <div className="preview-summary">
            <strong>{includedCount}</strong> of {previewRows.length} selected
            <button onClick={() => setAllIncluded(true)}>Select all</button>
            <button onClick={() => setAllIncluded(false)}>Deselect all</button>
          </div>
        </div>

        {previewRows.length > PAGE_SIZE && (
          <div className="preview-pagination">
            <button disabled={previewPage === 0} onClick={() => setPreviewPage((p) => p - 1)}>‹ Prev</button>
            <span>Page {previewPage + 1} of {totalPages} · rows {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, previewRows.length)} of {previewRows.length}</span>
            <button disabled={previewPage >= totalPages - 1} onClick={() => setPreviewPage((p) => p + 1)}>Next ›</button>
          </div>
        )}

        {(analysis?.bodyVarCount || 0) > 0 && (
          <div className="bulk-var-row">
            <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>Apply a value to every row:</span>
            {bulkVarInputs.map((v, i) => (
              <span key={i} style={{ display: "flex", gap: 4 }}>
                <input
                  placeholder={`{{${i + 1}}}`}
                  value={v}
                  onChange={(e) => { const next = [...bulkVarInputs]; next[i] = e.target.value; setBulkVarInputs(next); }}
                />
                <button onClick={() => applyBulkVar(i)}>Apply</button>
              </span>
            ))}
          </div>
        )}

        <div className="card preview-table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Phone</th>
                <th>Contact</th>
                {Array.from({ length: analysis?.bodyVarCount || 0 }, (_, i) => <th key={i}>{`{{${i + 1}}}`}</th>)}
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((r, localIdx) => {
                const globalIdx = pageStart + localIdx;
                return (
                  <tr key={globalIdx} className={r.included ? "" : "row-excluded"}>
                    <td><input type="checkbox" checked={r.included} onChange={() => toggleIncluded(globalIdx)} /></td>
                    <td>
                      <input
                        className="cell-input"
                        style={{ fontFamily: "var(--mono)", width: 120 }}
                        value={r.wa_id}
                        onChange={(e) => updatePreviewPhone(globalIdx, e.target.value)}
                      />
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-soft)" }}>{r.label}</td>
                    {r.variables.map((v, vi) => (
                      <td key={vi}>
                        <input className="cell-input" value={v} onChange={(e) => updatePreviewVar(globalIdx, vi, e.target.value)} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button className="btn-primary" style={{ marginTop: 16 }} disabled={busy || includedCount === 0} onClick={handleConfirmSend}>
          {busy ? "Starting..." : scheduleEnabled ? `Schedule for ${includedCount} recipient(s)` : `Send to ${includedCount} recipient(s)`}
        </button>
      </div>
    );
  }

  // --- Compose screen ---
  return (
    <div className="panel-view">
      {error && <div className="banner error">{error}</div>}
      <div className="panel-grid">
        <div className="card">
          <h3>Compose broadcast</h3>

          <div className="field">
            <label>Approved template</label>
            <select value={templateName} onChange={(e) => handleSelectTemplate(e.target.value)}>
              <option value="">Select a template...</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.name} ({t.language})</option>
              ))}
            </select>
            {templates.length === 0 && (
              <span style={{ fontSize: 12, color: "var(--text-soft)" }}>
                No approved templates yet — templates must be reviewed by Meta before they can be used here.
              </span>
            )}
          </div>

          {selected && (
            <div className="field">
              <label>Preview</label>
              <div style={{ fontSize: 13, background: "var(--paper)", padding: 10, borderRadius: 6, border: "1px solid var(--line)" }}>
                {analysis.headerIsText && (
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    {selected.components.find((c) => c.type === "HEADER").text}
                  </div>
                )}
                <div>{selected.components?.find((c) => c.type === "BODY")?.text}</div>
                {analysis.footerText && (
                  <div style={{ color: "var(--text-soft)", fontSize: 11.5, marginTop: 6 }}>{analysis.footerText}</div>
                )}
                {analysis.buttons.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {analysis.buttons.map((b, i) => (
                      <span key={i} className="status-pill PENDING">{b.text}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {analysis?.headerVarCount > 0 && (
            <div className="field">
              <label>Header variables (same for every recipient)</label>
              {headerVars.map((v, i) => (
                <input key={i} placeholder={`Header {{${i + 1}}}`} value={v}
                  onChange={(e) => { const next = [...headerVars]; next[i] = e.target.value; setHeaderVars(next); }}
                  style={{ marginBottom: 6 }} />
              ))}
            </div>
          )}

          {analysis?.bodyVarCount > 0 && (
            <div className="field">
              <label>
                Body variables — default values{groupContacts.length > 0 ? ", used when a variable isn't mapped to a contact field below" : ", used unless a recipient's CSV row overrides them"}. You can still fine-tune per recipient in the next step.
              </label>
              {bodyVars.map((v, i) => (
                <input key={i} placeholder={`{{${i + 1}}}`} value={v}
                  onChange={(e) => { const next = [...bodyVars]; next[i] = e.target.value; setBodyVars(next); }}
                  style={{ marginBottom: 6 }} />
              ))}
            </div>
          )}

          {groupContacts.length > 0 && analysis?.bodyVarCount > 0 && (
            <div className="field">
              <label>Personalize from contact fields</label>
              {fieldMapping.map((key, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, width: 34 }}>{`{{${i + 1}}}`}</span>
                  <select value={key} onChange={(e) => { const next = [...fieldMapping]; next[i] = e.target.value; setFieldMapping(next); }} style={{ flex: 1 }}>
                    {fieldOptions.map((opt) => <option key={opt} value={opt}>{fieldLabel(opt)}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}

          {analysis?.dynamicUrlButtonIndex > -1 && (
            <div className="field">
              <label>Dynamic URL button suffix (same for every recipient)</label>
              <input value={buttonVar} onChange={(e) => setButtonVar(e.target.value)} placeholder="e.g. order/12345" />
            </div>
          )}

          <div className="field">
            <label>Recipients</label>

            {groupContacts.length > 0 ? (
              <div className="source-banner">
                Sending to <strong>{groupContacts.length}</strong> contact(s) from <strong>{groupLabel}</strong>.
                <button type="button" onClick={clearRecipientSource}>Clear</button>
              </div>
            ) : (
              <>
                <textarea
                  value={recipientsText}
                  onChange={(e) => { setRecipientsText(e.target.value); setCsvRows([]); setCsvFileName(""); }}
                  placeholder={"One number per line, E.164 without \"+\" (e.g. 919876543210)\n919812345678"}
                  disabled={csvRows.length > 0}
                  style={{ minHeight: 100 }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                  <button type="button" className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} onClick={() => fileInputRef.current?.click()}>
                    Or upload a CSV
                  </button>
                  <input ref={fileInputRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={handleCsvFile} />
                  {csvFileName && (
                    <span style={{ fontSize: 12 }}>
                      ✓ {csvFileName} <button type="button" onClick={clearRecipientSource} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 12 }}>remove</button>
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 11.5, color: "var(--text-soft)", marginTop: 4, display: "block" }}>
                  CSV format: <code>phone</code> alone for a plain broadcast, or <code>phone,value1,value2,...</code>
                  to fill this template's body variables differently per recipient. Or pick a saved group from the
                  Contacts tab instead — its fields can personalize the message too.
                </span>
              </>
            )}
            <span style={{ fontSize: 12, marginTop: 4, display: "block" }}>{recipientCount} recipient(s)</span>
          </div>

          <div className="field">
            <label>
              <input type="checkbox" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.target.checked)} style={{ marginRight: 6 }} />
              Schedule for later instead of sending now
            </label>
            {scheduleEnabled && (
              <input
                type="datetime-local"
                value={scheduleAt}
                min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                onChange={(e) => setScheduleAt(e.target.value)}
                style={{ marginTop: 6 }}
              />
            )}
          </div>

          <button className="btn-primary" disabled={!selected || recipientCount === 0 || (scheduleEnabled && !scheduleAt)} onClick={handleBuildPreview}>
            Review {recipientCount} recipient(s) before sending
          </button>
        </div>

        <div className="card">
          <h3>{activeJob ? "Progress" : "Results"}</h3>
          <ProgressPanel job={activeJob} onExport={handleExport} onCancel={handleCancel} />

          {history.length > 0 && (
            <>
              <div className="form-section-label">History</div>
              {history.map((j) => (
                <button
                  key={j.id}
                  className="history-row"
                  onClick={() => { setActiveJobId(j.id); setActiveJob(j); }}
                >
                  <span>{j.template_name}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                    {j.status === "scheduled" ? "scheduled" : `${j.sent}/${j.total}${j.failed > 0 ? ` (${j.failed} failed)` : ""}`}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
