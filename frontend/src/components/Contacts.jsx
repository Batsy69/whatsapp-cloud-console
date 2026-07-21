import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";

const FIELD_ALIASES = {
  phone: "wa_id", mobile: "wa_id", number: "wa_id", "phone number": "wa_id", whatsapp: "wa_id", wa_id: "wa_id",
  name: "name", "full name": "name",
  company: "company", "company name": "company", business: "company",
  city: "city",
  state: "state",
  email: "email", "email id": "email", "e-mail": "email",
  group: "group", category: "group",
};

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

function parseDirectoryCsv(text) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map(parseCsvLine);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows
    .slice(1)
    .map((row) => {
      const record = { custom_fields: {} };
      header.forEach((h, i) => {
        const val = (row[i] || "").trim();
        if (!val) return;
        const mapped = FIELD_ALIASES[h];
        if (mapped) record[mapped] = val;
        else record.custom_fields[h] = val;
      });
      if (Object.keys(record.custom_fields).length === 0) delete record.custom_fields;
      return record;
    })
    .filter((r) => r.wa_id);
}

const emptyForm = () => ({ wa_id: "", name: "", company: "", city: "", state: "", email: "", group_id: "" });

// "group:3", "failed", or "all"
function parseView(view) {
  if (view === "all" || view === "failed") return { groupId: null, failedOnly: view === "failed" };
  return { groupId: Number(view.split(":")[1]), failedOnly: false };
}

export default function Contacts({ onBroadcastToSelection }) {
  const [groups, setGroups] = useState([]);
  const [view, setView] = useState("all");
  const [contacts, setContacts] = useState([]);
  const [failedCount, setFailedCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [expandedWaId, setExpandedWaId] = useState(null);
  const [historyCache, setHistoryCache] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [editingWaId, setEditingWaId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [newGroupName, setNewGroupName] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  async function refresh() {
    const { groupId, failedOnly } = parseView(view);
    const [g, c, failed] = await Promise.all([
      api.getGroups(),
      api.getDirectory(groupId, failedOnly),
      api.getDirectory(null, true),
    ]);
    setGroups(g);
    setContacts(c);
    setFailedCount(failed.length);
    setSelectedIds(new Set());
  }

  useEffect(() => { refresh(); }, [view]);

  function openAddForm() {
    setEditingWaId(null);
    setForm(emptyForm());
    setShowForm(true);
  }

  function openEditForm(contact) {
    setEditingWaId(contact.wa_id);
    setForm({
      wa_id: contact.wa_id,
      name: contact.name || "",
      company: contact.company || "",
      city: contact.city || "",
      state: contact.state || "",
      email: contact.email || "",
      group_id: contact.group_id || "",
    });
    setShowForm(true);
  }

  async function handleSaveContact(e) {
    e.preventDefault();
    if (!form.wa_id.trim()) return;
    setError("");
    try {
      await api.upsertDirectoryContact({ ...form, group_id: form.group_id ? Number(form.group_id) : null });
      setForm(emptyForm());
      setShowForm(false);
      setEditingWaId(null);
      setInfo(editingWaId ? "Contact updated." : "Contact added.");
      refresh();
    } catch (e2) {
      setError(e2.message);
    }
  }

  async function handleCreateGroup() {
    if (!newGroupName.trim()) return;
    await api.createGroup(newGroupName.trim());
    setNewGroupName("");
    refresh();
  }

  async function handleDeleteGroup(id) {
    if (!confirm("Delete this group? Contacts in it are kept, just ungrouped.")) return;
    await api.deleteGroup(id);
    if (view === `group:${id}`) setView("all");
    else refresh();
  }

  async function handleDeleteContact(waId) {
    if (!confirm(`Remove ${waId} from your contacts? This also deletes any message history with them.`)) return;
    await api.deleteDirectoryContact(waId);
    refresh();
  }

  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const text = await file.text();
      const records = parseDirectoryCsv(text);
      if (records.length === 0) {
        setError("No valid rows found. Make sure the first row is a header with recognizable column names (phone, name, company, city, state, email, group).");
        return;
      }
      const groupNames = [...new Set(records.filter((r) => r.group).map((r) => r.group))];
      const groupIdByName = {};
      for (const name of groupNames) {
        const g = await api.createGroup(name);
        groupIdByName[name] = g.id;
      }
      const rows = records.map((r) => ({ ...r, group_id: r.group ? groupIdByName[r.group] : undefined }));
      const res = await api.importDirectory(rows);
      setInfo(`Imported ${res.imported} contact(s)${res.skipped ? `, skipped ${res.skipped} invalid row(s)` : ""}.`);
      refresh();
    } catch (e2) {
      setError(e2.message);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  async function toggleHistory(waId) {
    if (expandedWaId === waId) {
      setExpandedWaId(null);
      return;
    }
    setExpandedWaId(waId);
    if (!historyCache[waId]) {
      const rows = await api.getContactHistory(waId);
      setHistoryCache((prev) => ({ ...prev, [waId]: rows }));
    }
  }

  function toggleSelected(waId) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(waId)) next.delete(waId);
      else next.add(waId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === contacts.length ? new Set() : new Set(contacts.map((c) => c.wa_id))));
  }

  const activeGroupName = useMemo(() => {
    if (!view.startsWith("group:")) return null;
    return groups.find((g) => g.id === Number(view.split(":")[1]))?.name;
  }, [groups, view]);

  const viewTitle = view === "all" ? "All contacts" : view === "failed" ? "Failed sends" : activeGroupName || "Group";
  const selectedContacts = useMemo(() => contacts.filter((c) => selectedIds.has(c.wa_id)), [contacts, selectedIds]);

  function handleBroadcastClick() {
    const list = selectedContacts.length > 0 ? selectedContacts : contacts;
    const label = selectedContacts.length > 0 ? `${selectedContacts.length} selected contact(s)` : viewTitle;
    onBroadcastToSelection(list, label);
  }

  return (
    <div className="panel-view">
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="contacts-layout">
        <div className="card contacts-sidebar">
          <h3>Groups</h3>
          <button className={`group-chip ${view === "all" ? "active" : ""}`} onClick={() => setView("all")}>
            All contacts
          </button>
          {groups.map((g) => (
            <div key={g.id} className="group-chip-row">
              <button className={`group-chip ${view === `group:${g.id}` ? "active" : ""}`} onClick={() => setView(`group:${g.id}`)}>
                {g.name} <span className="group-count">{g.contact_count}</span>
              </button>
              <button className="group-delete" aria-label={`Delete group ${g.name}`} onClick={() => handleDeleteGroup(g.id)}>✕</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 10, marginBottom: 14 }}>
            <input placeholder="New group name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontSize: 12.5 }} />
            <button className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} onClick={handleCreateGroup}>+</button>
          </div>

          {failedCount > 0 && (
            <button className={`group-chip failed-chip ${view === "failed" ? "active" : ""}`} onClick={() => setView("failed")}>
              ⚠ Failed sends <span className="group-count">{failedCount}</span>
            </button>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>{viewTitle} ({contacts.length})</h3>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} disabled={busy} onClick={() => fileInputRef.current?.click()}>
                {busy ? "Importing..." : "Import CSV"}
              </button>
              <input ref={fileInputRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={handleImport} />
              <button className="btn-primary" onClick={openAddForm}>+ Add contact</button>
            </div>
          </div>

          {view === "failed" && contacts.length > 0 && (
            <div className="banner error" style={{ fontSize: 12.5 }}>
              These contacts didn't receive their most recent broadcast. Select the ones you want to retry and
              click Broadcast below — this clears their failed flag the moment a send to them succeeds.
            </div>
          )}

          {contacts.length > 0 && (
            <div className="selection-bar">
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                <input type="checkbox" checked={selectedIds.size === contacts.length} onChange={toggleSelectAll} />
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
              </label>
              <button className="btn-primary" onClick={handleBroadcastClick}>
                Broadcast to {selectedContacts.length > 0 ? selectedContacts.length : contacts.length} {selectedContacts.length > 0 ? "selected" : ""} contact(s)
              </button>
            </div>
          )}

          {showForm && (
            <form onSubmit={handleSaveContact} className="add-contact-form">
              <input required placeholder="Phone (e.g. 919876543210)" value={form.wa_id} disabled={!!editingWaId} onChange={(e) => setForm({ ...form, wa_id: e.target.value })} />
              <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input placeholder="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              <input placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              <input placeholder="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
              <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <select value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })}>
                <option value="">No group</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-primary" type="submit">{editingWaId ? "Update contact" : "Save contact"}</button>
                <button type="button" className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} onClick={() => { setShowForm(false); setEditingWaId(null); }}>Cancel</button>
              </div>
            </form>
          )}

          <table>
            <thead>
              <tr><th></th><th>Name</th><th>Phone</th><th>Company</th><th>City</th><th>State</th><th>Email</th><th>Group</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <Fragment key={c.wa_id}>
                  <tr>
                    <td><input type="checkbox" checked={selectedIds.has(c.wa_id)} onChange={() => toggleSelected(c.wa_id)} /></td>
                    <td>{c.name}</td>
                    <td style={{ fontFamily: "var(--mono)" }}>{c.wa_id}</td>
                    <td>{c.company || "—"}</td>
                    <td>{c.city || "—"}</td>
                    <td>{c.state || "—"}</td>
                    <td>{c.email || "—"}</td>
                    <td>{c.group_name || "—"}</td>
                    <td>
                      {c.last_broadcast_status ? (
                        <button
                          className={`status-badge ${c.last_broadcast_status} status-badge-btn`}
                          title={c.last_broadcast_error || "Click to view full broadcast history"}
                          onClick={() => toggleHistory(c.wa_id)}
                        >
                          {c.last_broadcast_status === "failed" ? `Failed · ${c.last_broadcast_template}` : "Sent"}
                          {" "}{expandedWaId === c.wa_id ? "▴" : "▾"}
                        </button>
                      ) : "—"}
                    </td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <button className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} onClick={() => openEditForm(c)}>Edit</button>
                      <button className="btn-danger" onClick={() => handleDeleteContact(c.wa_id)}>Delete</button>
                    </td>
                  </tr>
                  {expandedWaId === c.wa_id && (
                    <tr className="history-row-expanded">
                      <td colSpan={10}>
                        {!historyCache[c.wa_id] ? (
                          <span style={{ fontSize: 12, color: "var(--text-soft)" }}>Loading history...</span>
                        ) : historyCache[c.wa_id].length === 0 ? (
                          <span style={{ fontSize: 12, color: "var(--text-soft)" }}>No broadcast history yet.</span>
                        ) : (
                          <table className="history-detail-table">
                            <thead>
                              <tr><th>Template</th><th>When</th><th>Result</th><th>Error</th></tr>
                            </thead>
                            <tbody>
                              {historyCache[c.wa_id].map((h, i) => (
                                <tr key={i}>
                                  <td>{h.template_name}</td>
                                  <td style={{ fontFamily: "var(--mono)" }}>{h.updated_at ? new Date(h.updated_at).toLocaleString() : "pending"}</td>
                                  <td><span className={`status-badge ${h.status}`}>{h.status}</span></td>
                                  <td style={{ color: "var(--danger)" }}>{h.error || ""}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {contacts.length === 0 && (
                <tr><td colSpan={10} style={{ color: "var(--text-soft)" }}>
                  {view === "failed" ? "No failed sends right now." : "No contacts yet. They're added automatically after any broadcast, or add/import them here."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
