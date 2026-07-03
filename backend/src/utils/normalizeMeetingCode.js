export const normalizeMeetingCode = (value = "") => {
  const raw = String(value).trim();
  const lastPathPart = raw.split("/").filter(Boolean).pop() || raw;
  return lastPathPart.replace(/[^a-zA-Z0-9-_]/g, "").toUpperCase();
};
