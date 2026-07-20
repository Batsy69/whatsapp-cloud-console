import { useState } from "react";
import Inbox from "./components/Inbox.jsx";
import Templates from "./components/Templates.jsx";
import Broadcast from "./components/Broadcast.jsx";
import Contacts from "./components/Contacts.jsx";

const TABS = [
  { id: "inbox", label: "Inbox", icon: "💬" },
  { id: "contacts", label: "Contacts", icon: "📇" },
  { id: "templates", label: "Templates", icon: "📄" },
  { id: "broadcast", label: "Broadcast", icon: "📣" },
];

export default function App() {
  const [tab, setTab] = useState("inbox");
  const [broadcastPrefill, setBroadcastPrefill] = useState(null);

  function handleBroadcastToGroup(recipients, label) {
    setBroadcastPrefill({ recipients, label });
    setTab("broadcast");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          WA CONSOLE
          <small>Cloud API · direct</small>
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
            aria-label={t.label}
          >
            <span className="nav-icon" aria-hidden="true">{t.icon}</span>
            <span className="nav-label">{t.label}</span>
          </button>
        ))}
        <div className="sidebar-footer">graph.facebook.com</div>
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{TABS.find((t) => t.id === tab)?.label}</h1>
          <span className="sub">v23.0</span>
        </div>
        <div className="view">
          {tab === "inbox" && <Inbox />}
          {tab === "contacts" && <Contacts onBroadcastToGroup={handleBroadcastToGroup} />}
          {tab === "templates" && <Templates />}
          {tab === "broadcast" && <Broadcast prefill={broadcastPrefill} onConsumePrefill={() => setBroadcastPrefill(null)} />}
        </div>
      </main>
    </div>
  );
}
