import { useEffect, useMemo, useRef, useState } from "react";
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

export default function Contacts({ onBroadcastToGroup }) {
  const [groups, setGroups] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [newGroupName, setNewGroupName] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  async function refresh() {
    const [g, c] = await Promise.all([api.getGroups(), api.getDirectory(activeGroupId)]);
    setGroups(g);
    setContacts(c);
  }

  useEffect(() => { refresh(); }, [activeGroupId]);

  async function handleAddContact(e) {
    e.preventDefault();
    if (!form.wa_id.trim()) return;
    setError("");
    try {
      await api.upsertDirectoryContact({ ...form, group_id: form.group_id || null });
      setForm(emptyForm());
      setShowAddForm(false);
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
    if (activeGroupId === id) setActiveGroupId(null);
    refresh();
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

  const activeGroupName = useMemo(
    () => groups.find((g) => g.id === activeGroupId)?.name,
    [groups, activeGroupId]
  );

  return (
    <div className="panel-view">
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="contacts-layout">
        <div className="card contacts-sidebar">
          <h3>Groups</h3>
          <button className={`group-chip ${activeGroupId === null ? "active" : ""}`} onClick={() => setActiveGroupId(null)}>
            All contacts
          </button>
          {groups.map((g) => (
            <div key={g.id} className="group-chip-row">
              <button className={`group-chip ${activeGroupId === g.id ? "active" : ""}`} onClick={() => setActiveGroupId(g.id)}>
                {g.name} <span className="group-count">{g.contact_count}</span>
              </button>
              <button className="group-delete" aria-label={`Delete group ${g.name}`} onClick={() => handleDeleteGroup(g.id)}>✕</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <input placeholder="New group name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontSize: 12.5 }} />
            <button className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} onClick={handleCreateGroup}>+</button>
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h3 style={{ margin: 0 }}>{activeGroupName || "All contacts"} ({contacts.length})</h3>
            <div style={{ display: "flex", gap: 8 }}>
              {activeGroupId && contacts.length > 0 && (
                <button className="btn-primary" onClick={() => onBroadcastToGroup(contacts, activeGroupName)}>
                  Broadcast to this group
                </button>
              )}
              <button className="btn-danger" style={{ borderColor: "var(--line)", color: "var(--text-soft)" }} disabled={busy} onClick={() => fileInputRef.current?.click()}>
                {busy ? "Importing..." : "Import CSV"}
              </button>
              <input ref={fileInputRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={handleImport} />
              <button className="btn-primary" onClick={() => setShowAddForm((v) => !v)}>
                {showAddForm ? "Cancel" : "+ Add contact"}
              </button>
            </div>
          </div>

          {showAddForm && (
            <form onSubmit={handleAddContact} className="add-contact-form">
              <input required placeholder="Phone (e.g. 919876543210)" value={form.wa_id} onChange={(e) => setForm({ ...form, wa_id: e.target.value })} />
              <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input placeholder="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              <input placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              <input placeholder="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
              <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <select value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })}>
                <option value="">No group</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <button className="btn-primary" type="submit">Save contact</button>
            </form>
          )}

          <table>
            <thead>
              <tr><th>Name</th><th>Phone</th><th>Company</th><th>City</th><th>State</th><th>Email</th><th>Group</th><th></th></tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.wa_id}>
                  <td>{c.name}</td>
                  <td style={{ fontFamily: "var(--mono)" }}>{c.wa_id}</td>
                  <td>{c.company || "—"}</td>
                  <td>{c.city || "—"}</td>
                  <td>{c.state || "—"}</td>
                  <td>{c.email || "—"}</td>
                  <td>{c.group_name || "—"}</td>
                  <td><button className="btn-danger" onClick={() => handleDeleteContact(c.wa_id)}>Delete</button></td>
                </tr>
              ))}
              {contacts.length === 0 && (
                <tr><td colSpan={8} style={{ color: "var(--text-soft)" }}>
                  No contacts yet. They're added automatically after any broadcast, or add/import them here.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
