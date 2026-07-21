async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const mediaUrl = (id) => `/api/media/${id}`;

export const api = {
  getConversations: (includeArchived = false) => request(`/conversations${includeArchived ? "?archived=1" : ""}`),
  getMessages: (waId) => request(`/conversations/${waId}/messages`),
  getContact: (waId) => request(`/conversations/${waId}`),
  markRead: (waId) => request(`/conversations/${waId}/read`, { method: "POST" }),
  archiveConversation: (waId) => request(`/conversations/${waId}/archive`, { method: "POST" }),
  unarchiveConversation: (waId) => request(`/conversations/${waId}/unarchive`, { method: "POST" }),
  deleteConversation: (waId) => request(`/conversations/${waId}`, { method: "DELETE" }),

  sendText: (to, text) =>
    request("/send", { method: "POST", body: JSON.stringify({ to, type: "text", text }) }),

  sendMedia: (to, type, media_id, caption, filename) =>
    request("/send", {
      method: "POST",
      body: JSON.stringify({ to, type, media_id, caption, filename }),
    }),

  sendLocation: (to, latitude, longitude, name, address) =>
    request("/send", {
      method: "POST",
      body: JSON.stringify({ to, type: "location", latitude, longitude, name, address }),
    }),

  sendInteractiveButtons: (to, body_text, buttons) =>
    request("/send", {
      method: "POST",
      body: JSON.stringify({ to, type: "interactive_buttons", body_text, buttons }),
    }),

  sendTemplate: (to, template_name, language_code, components, display_body) =>
    request("/send", {
      method: "POST",
      body: JSON.stringify({ to, type: "template", template_name, language_code, components, display_body }),
    }),

  uploadMedia: async (file) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/media/upload", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed");
    return data; // { media_id, mime_type, filename }
  },

  getTemplates: () => request("/templates"),
  createTemplate: (payload) => request("/templates", { method: "POST", body: JSON.stringify(payload) }),
  deleteTemplate: (name) => request(`/templates/${encodeURIComponent(name)}`, { method: "DELETE" }),

  uploadHeaderMedia: async (file) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/templates/upload-header-media", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Header media upload failed");
    return data; // { handle, mime_type, filename }
  },

  startBroadcast: (payload) => request("/broadcast", { method: "POST", body: JSON.stringify(payload) }),
  getBroadcastJobs: () => request("/broadcast/jobs"),
  getBroadcastJob: (id) => request(`/broadcast/jobs/${id}`),
  cancelBroadcastJob: (id) => request(`/broadcast/jobs/${id}`, { method: "DELETE" }),
  retryBroadcastJob: (id) => request(`/broadcast/jobs/${id}/retry`, { method: "POST" }),
  exportBroadcastJobUrl: (id) => `/api/broadcast/jobs/${id}/export`,

  getGroups: () => request("/groups"),
  createGroup: (name) => request("/groups", { method: "POST", body: JSON.stringify({ name }) }),
  deleteGroup: (id) => request(`/groups/${id}`, { method: "DELETE" }),

  getDirectory: (groupId, failedOnly = false) =>
    request(`/directory${groupId ? `?group_id=${groupId}` : failedOnly ? "?failed=1" : ""}`),
  upsertDirectoryContact: (payload) => request("/directory", { method: "POST", body: JSON.stringify(payload) }),
  importDirectory: (rows) => request("/directory/import", { method: "POST", body: JSON.stringify({ rows }) }),
  deleteDirectoryContact: (waId) => request(`/directory/${waId}`, { method: "DELETE" }),
  getContactHistory: (waId) => request(`/directory/${waId}/history`),
};
