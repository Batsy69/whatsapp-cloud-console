import { useEffect, useRef, useState } from "react";
import { api, mediaUrl } from "../api.js";

function WindowPill({ open, expiresAt }) {
  const label = open
    ? `open · ${Math.max(0, Math.round((expiresAt - Date.now()) / 3600000))}h left`
    : "closed · template required";
  return (
    <span className={`window-pill ${open ? "open" : "closed"}`}>
      <span className="ring" />
      {label}
    </span>
  );
}

function BubbleContent({ m }) {
  const url = m.media_id ? mediaUrl(m.media_id) : null;
  const hasCaption = m.body && !m.body.startsWith("[");

  switch (m.type) {
    case "image":
      return (
        <>
          {url && <img src={url} alt="" className="bubble-media" />}
          {hasCaption && <div>{m.body}</div>}
        </>
      );
    case "video":
      return (
        <>
          {url && <video src={url} controls className="bubble-media" />}
          {hasCaption && <div>{m.body}</div>}
        </>
      );
    case "audio":
      return url ? <audio src={url} controls /> : <span>{m.body}</span>;
    case "sticker":
      return url ? <img src={url} alt="sticker" className="bubble-sticker" /> : <span>{m.body}</span>;
    case "document":
      return url ? (
        <a href={url} target="_blank" rel="noreferrer">📄 {m.body}</a>
      ) : (
        <span>{m.body}</span>
      );
    case "location":
      return m.latitude != null ? (
        <a href={`https://maps.google.com/?q=${m.latitude},${m.longitude}`} target="_blank" rel="noreferrer">
          📍 {m.body}
        </a>
      ) : (
        <span>{m.body}</span>
      );
    default:
      return <span>{m.body}</span>;
  }
}

export default function Inbox() {
  const [conversations, setConversations] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [loc, setLoc] = useState({ lat: "", lng: "", name: "" });
  const [error, setError] = useState("");
  const bodyRef = useRef(null);
  const fileInputRef = useRef(null);

  async function refreshList() {
    const data = await api.getConversations(showArchived);
    setConversations(data);
  }

  useEffect(() => {
    refreshList();
    const t = setInterval(refreshList, 5000);
    return () => clearInterval(t);
  }, [showArchived]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    async function load() {
      const msgs = await api.getMessages(selected.wa_id);
      if (!cancelled) setMessages(msgs);
    }
    load();
    const t = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [selected]);

  // Mark the latest inbound message read whenever a conversation is opened.
  useEffect(() => {
    if (selected) api.markRead(selected.wa_id).catch(() => {});
  }, [selected?.wa_id]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages]);

  async function refreshThread() {
    const msgs = await api.getMessages(selected.wa_id);
    setMessages(msgs);
  }

  async function handleSend() {
    if (!draft.trim() || !selected) return;
    setSending(true);
    setError("");
    try {
      await api.sendText(selected.wa_id, draft.trim());
      setDraft("");
      await refreshThread();
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file || !selected) return;
    setUploading(true);
    setError("");
    try {
      const { media_id } = await api.uploadMedia(file);
      const type = file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
        ? "video"
        : file.type.startsWith("audio/")
        ? "audio"
        : "document";
      await api.sendMedia(selected.wa_id, type, media_id, "", file.name);
      await refreshThread();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handleSendLocation() {
    if (!loc.lat || !loc.lng || !selected) return;
    setError("");
    try {
      await api.sendLocation(selected.wa_id, Number(loc.lat), Number(loc.lng), loc.name);
      setLoc({ lat: "", lng: "", name: "" });
      setLocationOpen(false);
      await refreshThread();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleArchive() {
    if (!selected) return;
    if (showArchived) await api.unarchiveConversation(selected.wa_id);
    else await api.archiveConversation(selected.wa_id);
    setSelected(null);
    refreshList();
  }

  async function handleDelete() {
    if (!selected) return;
    if (!confirm(`Permanently delete the conversation with ${selected.name || selected.wa_id}? This removes the full message history and can't be undone.`)) return;
    await api.deleteConversation(selected.wa_id);
    setSelected(null);
    refreshList();
  }

  return (
    <div className={`inbox ${selected ? "show-thread" : "show-list"}`}>
      <div className="conv-list">
        <div className="conv-list-toolbar">
          <button
            className={`archive-toggle ${showArchived ? "active" : ""}`}
            onClick={() => { setShowArchived((v) => !v); setSelected(null); }}
          >
            {showArchived ? "← Back to inbox" : "Archived"}
          </button>
        </div>
        {conversations.length === 0 && (
          <div className="conv-empty">
            {showArchived
              ? "No archived conversations."
              : "No conversations yet. They appear here once someone messages your WhatsApp number and your webhook receives it."}
          </div>
        )}
        {conversations.map((c) => (
          <button
            key={c.wa_id}
            className={`conv-row ${selected?.wa_id === c.wa_id ? "selected" : ""}`}
            onClick={() => setSelected(c)}
          >
            <span className="name">{c.name || c.wa_id}</span>
            <span className="wa-id">{c.wa_id}</span>
            <span className="preview">{c.last_body}</span>
          </button>
        ))}
      </div>

      <div className="thread">
        {!selected ? (
          <div className="conv-empty" style={{ margin: "auto" }}>
            Select a conversation to view the thread.
          </div>
        ) : (
          <>
            <div className="thread-header">
              <div style={{ display: "flex", alignItems: "center" }}>
                <button className="back-btn" onClick={() => setSelected(null)} aria-label="Back to conversations">
                  ←
                </button>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{selected.name || selected.wa_id}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-soft)" }}>
                    {selected.wa_id}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <WindowPill open={selected.window_open} expiresAt={selected.window_expires_at} />
                <button className="icon-btn" title={showArchived ? "Unarchive" : "Archive"} aria-label={showArchived ? "Unarchive conversation" : "Archive conversation"} onClick={handleArchive}>
                  {showArchived ? "📤" : "🗄"}
                </button>
                <button className="icon-btn" title="Delete conversation" aria-label="Delete conversation" onClick={handleDelete}>
                  🗑
                </button>
              </div>
            </div>

            <div className="thread-body" ref={bodyRef}>
              {messages.map((m) => (
                <div key={m.id} className={`bubble ${m.direction}`}>
                  <BubbleContent m={m} />
                  <div className="meta">
                    {new Date(m.timestamp).toLocaleString()}
                    {m.direction === "outbound" && m.status ? ` · ${m.status}` : ""}
                  </div>
                </div>
              ))}
            </div>

            {error && <div className="reply-blocked">{error}</div>}

            {selected.window_open ? (
              <>
                {locationOpen && (
                  <div className="location-form">
                    <input placeholder="Latitude" value={loc.lat} onChange={(e) => setLoc({ ...loc, lat: e.target.value })} />
                    <input placeholder="Longitude" value={loc.lng} onChange={(e) => setLoc({ ...loc, lng: e.target.value })} />
                    <input placeholder="Label (optional)" value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} />
                    <button className="btn-primary" onClick={handleSendLocation}>Send</button>
                  </div>
                )}
                <div className="reply-bar">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Attach photo, video, audio or document"
                    aria-label="Attach file"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    📎
                  </button>
                  <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileChange} />
                  <button
                    type="button"
                    className="icon-btn"
                    title="Send location"
                    aria-label="Send location"
                    onClick={() => setLocationOpen((v) => !v)}
                  >
                    📍
                  </button>
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={uploading ? "Uploading..." : "Type a reply..."}
                    onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  />
                  <button onClick={handleSend} disabled={sending || !draft.trim()}>
                    Send
                  </button>
                </div>
              </>
            ) : (
              <div className="reply-blocked">
                This contact's 24-hour window has closed. Send an approved template from the
                Broadcast tab to re-open the conversation.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
