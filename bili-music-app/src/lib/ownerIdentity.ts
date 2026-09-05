import { sanitizeText } from "./sanitize";

export function localAppOwnerId(): string {
  const value = sanitizeText(process.env.APP_OWNER_ID || process.env.KERNEL_EXTERNAL_OWNER_ID || "local", 128);
  return /^[A-Za-z0-9_.:@-]{1,128}$/.test(value) ? value : "local";
}
export function accountLibraryEnabled(): boolean {
  // Explicit local mode remains available for a trusted legacy installation.
  // Cookies and the old APP_SINGLE_USER_MODE flag never choose an account.
  return process.env.APP_LIBRARY_MODE !== "local";
}
export function appOwnerIdFromBiliUid(value: unknown): string {
  const uid = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  return /^\d{1,24}$/.test(uid) ? `bili:${uid}` : "local";
}
export function guestAppOwnerId(): string {
  return "guest:" + localAppOwnerId();
}
