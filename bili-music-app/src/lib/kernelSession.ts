import { accountLibraryEnabled, appOwnerIdFromBiliUid, guestAppOwnerId, localAppOwnerId } from "./ownerIdentity";
import { readAccountOnce } from "./accountRequest";
import { createHash } from "node:crypto";
import { readKernelJson } from "./kernelClient";
import { sanitizeText } from "./sanitize";

export type KernelProfileResponse = {
  profile_id: string;
  external_owner_id: string;
  status: "created" | "exists";
};

export type KernelLoginStartResponse = {
  login_session_id: string;
  status: "pending";
  message: string;
  qr_image_url?: string | null;
  qr_image_sha256?: string | null;
  expires_in_seconds?: number | null;
};

export type KernelLoginStatusResponse = {
  profile_id: string;
  logged_in: boolean;
  bili_uid?: string | null;
  nickname?: string | null;
  last_verified_at?: string | null;
  login_status?: string;
};

export function defaultKernelExternalOwnerId(): string {
  return sanitizeText(process.env.KERNEL_EXTERNAL_OWNER_ID || process.env.APP_OWNER_ID || "local", 128) || "local";
}

export async function ensureDefaultKernelProfile(): Promise<KernelProfileResponse> {
  const externalOwnerId = defaultKernelExternalOwnerId();
  return readKernelJson<KernelProfileResponse>("/v1/profiles", {
    method: "POST",
    body: JSON.stringify({ external_owner_id: externalOwnerId })
  });
}

export async function getDefaultKernelLoginStatus(): Promise<{
  profileId: string;
  externalOwnerId: string;
  loggedIn: boolean;
  biliUid?: string | null;
  nickname?: string | null;
  lastVerifiedAt?: string | null;
  appOwnerId: string;
  libraryMode: "local" | "account";
  sessionKey: string;
  loginStatus: string;
}> {
  return readAccountOnce(readDefaultKernelLoginStatus);
}

async function readDefaultKernelLoginStatus() {
  const profile = await ensureDefaultKernelProfile();
  const payload = await readKernelJson<KernelLoginStatusResponse>(
    `/v1/profiles/${encodeURIComponent(profile.profile_id)}/login/status?external_owner_id=${encodeURIComponent(
      profile.external_owner_id
    )}`
  );
  const verifiedOwner = appOwnerIdFromBiliUid(payload.bili_uid);
  if (payload.logged_in && verifiedOwner === "local") throw new Error("Kernel returned an invalid logged-in identity");
  return {
    profileId: payload.profile_id,
    externalOwnerId: profile.external_owner_id,
    loggedIn: payload.logged_in,
    biliUid: payload.bili_uid,
    nickname: payload.nickname,
    lastVerifiedAt: payload.last_verified_at,
    libraryMode: accountLibraryEnabled() ? "account" as const : "local" as const,
    appOwnerId: accountLibraryEnabled() ? payload.logged_in ? verifiedOwner : guestAppOwnerId() : localAppOwnerId(),
    sessionKey: createHash("sha256").update(JSON.stringify([payload.profile_id, payload.logged_in, payload.bili_uid, payload.last_verified_at])).digest("hex").slice(0, 24),
    loginStatus: payload.login_status || (payload.logged_in ? "logged_in" : "logged_out")
  };
}

export async function startDefaultKernelLogin(): Promise<{
  profileId: string;
  externalOwnerId: string;
  loginSessionId: string;
  status: "pending";
  message: string;
  qrImageSha256?: string | null;
  expiresInSeconds?: number | null;
}> {
  const profile = await ensureDefaultKernelProfile();
  const payload = await readKernelJson<KernelLoginStartResponse>(
    `/v1/profiles/${encodeURIComponent(profile.profile_id)}/login/start`,
    {
      method: "POST",
      body: JSON.stringify({ external_owner_id: profile.external_owner_id }),
      signal: AbortSignal.timeout(80000)
    }
  );
  return {
    profileId: profile.profile_id,
    externalOwnerId: profile.external_owner_id,
    loginSessionId: payload.login_session_id,
    status: payload.status,
    message: payload.message,
    qrImageSha256: payload.qr_image_sha256,
    expiresInSeconds: payload.expires_in_seconds
  };
}

export async function logoutDefaultKernelProfile(): Promise<void> {
  const profile = await ensureDefaultKernelProfile();
  await readKernelJson(`/v1/profiles/${encodeURIComponent(profile.profile_id)}/login/logout`, {
    method: "POST",
    body: JSON.stringify({ external_owner_id: profile.external_owner_id }),
  });
}
