import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"];
const HEADER_TYPES = ["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"];
const BUTTON_TYPES = ["QUICK_REPLY", "URL", "PHONE_NUMBER"];

// Meta's resumable upload API only accepts these exact MIME types.
const HEADER_ACCEPT = {
  IMAGE: "image/jpeg,image/jpg,image/png",
  VIDEO: "video/mp4",
  DOCUMENT: "application/pdf",
};

function extractVarNumbers(text) {
  const matches = [...(text || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(matches)].sort((a, b) => a - b);
}

const emptyForm = () => ({
  name: "",
  category: "UTILITY",
  language: "en_US",
  headerType: "NONE",
  headerText: "",
  headerExample: "",
  headerHandle: "",
  headerFileName: "",
  body: "",
  bodyExamples: {}, // { [varNumber]: exampleValue }
  footer: "",
  buttons: [], // { type, title, value, example }
});

export default function Templates() {
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [form, setForm] = useState(emptyForm());
  const [busy, setBusy] = useState(false);
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const headerFileRef = useRef(null);

  async function refresh() {
    try {
      setTemplates(await api.getTemplates());
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { refresh(); }, []);

  function addButton() {
    if (form.buttons.length >= 3) return;
    setForm({ ...form, buttons: [...form.buttons, { type: "QUICK_REPLY", title: "", value: "", example: "" }] });
  }
  function updateButton(i, patch) {
    const next = [...form.buttons];
    next[i] = { ...next[i], ...patch };
    setForm({ ...form, buttons: next });
  }
  function removeButton(i) {
    setForm({ ...form, buttons: form.buttons.filter((_, idx) => idx !== i) });
  }

  function handleHeaderTypeChange(headerType) {
    setForm({ ...form, headerType, headerText: "", headerExample: "", headerHandle: "", headerFileName: "" });
  }

  async function handleHeaderFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingHeader(true);
    setError("");
    try {
      const { handle } = await api.uploadHeaderMedia(file);
      setForm((f) => ({ ...f, headerHandle: handle, headerFileName: file.name }));
    } catch (e) {
      setError(e.message);
    } finally {
      setUploadingHeader(false);
      e.target.value = "";
    }
  }

  const bodyVarNumbers = extractVarNumbers(form.body);
  const headerVarNumbers = extractVarNumbers(form.headerText);

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    setInfo("");

    // Fail fast with a clear message instead of letting Meta bounce a 400.
    if (headerVarNumbers.length > 0 && !form.headerExample.trim()) {
      return setError("The header text has a {{1}} variable — add an example value for it.");
    }
    if (bodyVarNumbers.length > 0 && bodyVarNumbers.some((n) => !form.bodyExamples[n]?.trim())) {
      return setError("The body has variables — add an example value for each one.");
    }
    for (const b of form.buttons) {
      if (b.type === "URL" && /\{\{\d+\}\}/.test(b.value) && !b.example?.trim()) {
        return setError(`The "${b.title || "URL"}" button has a dynamic URL — add a full example URL for it.`);
      }
    }

    setBusy(true);
    try {
      const components = [];

      if (form.headerType === "TEXT" && form.headerText.trim()) {
        const header = { type: "HEADER", format: "TEXT", text: form.headerText.trim() };
        if (headerVarNumbers.length > 0) {
          header.example = { header_text: [form.headerExample.trim()] };
        }
        components.push(header);
      } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(form.headerType)) {
        if (!form.headerHandle) {
          setError(`Upload a sample ${form.headerType.toLowerCase()} for the header before submitting.`);
          setBusy(false);
          return;
        }
        components.push({
          type: "HEADER",
          format: form.headerType,
          example: { header_handle: [form.headerHandle] },
        });
      }

      const body = { type: "BODY", text: form.body };
      if (bodyVarNumbers.length > 0) {
        body.example = { body_text: [bodyVarNumbers.map((n) => form.bodyExamples[n].trim())] };
      }
      components.push(body);

      if (form.footer.trim()) {
        components.push({ type: "FOOTER", text: form.footer.trim() });
      }

      if (form.buttons.length) {
        components.push({
          type: "BUTTONS",
          buttons: form.buttons.map((b) => {
            if (b.type === "URL") {
              const btn = { type: "URL", text: b.title, url: b.value };
              if (/\{\{\d+\}\}/.test(b.value)) btn.example = [b.example.trim()];
              return btn;
            }
            if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: b.title, phone_number: b.value };
            return { type: "QUICK_REPLY", text: b.title };
          }),
        });
      }

      const res = await api.createTemplate({
        name: form.name.trim().toLowerCase().replace(/\s+/g, "_"),
        category: form.category,
        language: form.language,
        components,
      });
      setInfo(`Submitted. Status: ${res.status || "PENDING"} — Meta reviews new templates before they're usable.`);
      setForm(emptyForm());
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(name) {
    if (!confirm(`Delete template "${name}"? This can't be undone.`)) return;
    try {
      await api.deleteTemplate(name);
      refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  const needsHeaderUpload = ["IMAGE", "VIDEO", "DOCUMENT"].includes(form.headerType);

  return (
    <div className="panel-view">
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="panel-grid">
        <div className="card">
          <h3>Templates on this WABA</h3>
          <table>
            <thead>
              <tr><th>Name</th><th>Category</th><th>Language</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id || t.name}>
                  <td style={{ fontFamily: "var(--mono)" }}>{t.name}</td>
                  <td>{t.category}</td>
                  <td>{t.language}</td>
                  <td><span className={`status-pill ${t.status}`}>{t.status}</span></td>
                  <td><button className="btn-danger" onClick={() => handleDelete(t.name)}>Delete</button></td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr><td colSpan={5} style={{ color: "var(--text-soft)" }}>No templates yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Create template</h3>
          <form onSubmit={handleCreate}>
            <div className="form-section-label">Basics</div>
            <div className="field">
              <label>Name (lowercase, underscores)</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="order_shipped" />
            </div>
            <div className="field">
              <label>Category</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Language code</label>
              <input required value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="en_US" />
            </div>

            <div className="form-section-label">Header</div>
            <div className="field">
              <label>Header</label>
              <select value={form.headerType} onChange={(e) => handleHeaderTypeChange(e.target.value)}>
                {HEADER_TYPES.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>

            {form.headerType === "TEXT" && (
              <div className="field">
                <input value={form.headerText} onChange={(e) => setForm({ ...form, headerText: e.target.value })} placeholder="Header text — only one {{1}} allowed" />
                {headerVarNumbers.length > 0 && (
                  <input
                    style={{ marginTop: 6 }}
                    value={form.headerExample}
                    onChange={(e) => setForm({ ...form, headerExample: e.target.value })}
                    placeholder="Example value for {{1}} (required)"
                  />
                )}
              </div>
            )}

            {needsHeaderUpload && (
              <div className="field">
                <label>
                  Sample {form.headerType.toLowerCase()} for review
                  {form.headerType === "IMAGE" && " (jpeg/png)"}
                  {form.headerType === "VIDEO" && " (mp4 only)"}
                  {form.headerType === "DOCUMENT" && " (pdf only)"}
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    type="button"
                    className="btn-danger"
                    style={{ borderColor: "var(--line)", color: "var(--text-soft)" }}
                    disabled={uploadingHeader}
                    onClick={() => headerFileRef.current?.click()}
                  >
                    {uploadingHeader ? "Uploading..." : form.headerHandle ? "Replace file" : "Choose file"}
                  </button>
                  <input
                    ref={headerFileRef}
                    type="file"
                    accept={HEADER_ACCEPT[form.headerType]}
                    style={{ display: "none" }}
                    onChange={handleHeaderFile}
                  />
                  {form.headerHandle && (
                    <span style={{ fontSize: 12, color: "var(--accent)" }}>✓ {form.headerFileName}</span>
                  )}
                </div>
                <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>
                  Uploaded via Meta's resumable upload API to get a header_handle. This handle expires
                  after ~24h, so submit the template soon after uploading.
                </span>
              </div>
            )}

            <div className="form-section-label">Body</div>
            <div className="field">
              <label>Body text (use {"{{1}}"}, {"{{2}}"} for variables)</label>
              <textarea required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Hi {{1}}, your order #{{2}} has shipped." />
            </div>

            {bodyVarNumbers.length > 0 && (
              <div className="field">
                <label>Example values (required — Meta reviews templates against these)</label>
                {bodyVarNumbers.map((n) => (
                  <input
                    key={n}
                    placeholder={`Example for {{${n}}}`}
                    value={form.bodyExamples[n] || ""}
                    onChange={(e) => setForm({ ...form, bodyExamples: { ...form.bodyExamples, [n]: e.target.value } })}
                    style={{ marginBottom: 6 }}
                  />
                ))}
              </div>
            )}

            <div className="form-section-label">Footer</div>
            <div className="field">
              <label>Footer (optional)</label>
              <input value={form.footer} onChange={(e) => setForm({ ...form, footer: e.target.value })} placeholder="Reply STOP to opt out" />
            </div>

            <div className="form-section-label">Buttons</div>
            <div className="field">
              <label>Up to 3</label>
              {form.buttons.map((b, i) => {
                const isDynamicUrl = b.type === "URL" && /\{\{\d+\}\}/.test(b.value);
                return (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <select value={b.type} onChange={(e) => updateButton(i, { type: e.target.value, value: "", example: "" })} style={{ width: 120 }}>
                        {BUTTON_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input placeholder="Title" value={b.title} onChange={(e) => updateButton(i, { title: e.target.value })} style={{ flex: 1 }} />
                      {b.type !== "QUICK_REPLY" && (
                        <input
                          placeholder={b.type === "URL" ? "https://... (or ending in {{1}} for dynamic)" : "+1234567890"}
                          value={b.value}
                          onChange={(e) => updateButton(i, { value: e.target.value })}
                          style={{ flex: 1 }}
                        />
                      )}
                      <button type="button" className="btn-danger" aria-label={`Remove button ${i + 1}`} onClick={() => removeButton(i)}>✕</button>
                    </div>
                    {isDynamicUrl && (
                      <input
                        style={{ marginTop: 6 }}
                        value={b.example}
                        onChange={(e) => updateButton(i, { example: e.target.value })}
                        placeholder="Full example URL (required), e.g. https://rinix.in/orders/12345"
                      />
                    )}
                  </div>
                );
              })}
              {form.buttons.length < 3 && (
                <button type="button" className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} onClick={addButton}>
                  + Add button
                </button>
              )}
            </div>

            <button className="btn-primary" disabled={busy || uploadingHeader}>
              {busy ? "Submitting..." : "Submit for review"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
