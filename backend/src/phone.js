// WhatsApp always sends inbound numbers in full E.164-without-plus form
// (e.g. "918655357804"). If a broadcast or manual entry is typed without the
// country code (e.g. "8655357804"), it becomes a *different* wa_id and shows
// up as a separate, phantom conversation from the same real contact.
//
// This normalizes anything that looks like a bare 10-digit local number by
// prefixing DEFAULT_COUNTRY_CODE. It intentionally does nothing to numbers
// that already look like they include a country code (11+ digits), since
// guessing wrong there is worse than leaving them alone.

const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "91";

export function normalizePhone(raw) {
  if (!raw) return raw;
  const digits = String(raw).replace(/[^\d]/g, ""); // strip +, spaces, dashes, parens
  if (digits.length === 10) return DEFAULT_COUNTRY_CODE + digits;
  return digits;
}
