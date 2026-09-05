import { NextResponse } from "next/server";

import { getTrackById, updateTrack } from "./db";
import { kernelArtifactUrl } from "./kernelClient";
import { isTrackExpired } from "./tracks";
import { contentDispositionAttachment, downloadFileName } from "./trackApi";
import { sanitizeText } from "./sanitize";

const MEDIA_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified"
];

export async function proxyTrackMedia(input: {
  request: Request;
  trackId: number;
  appOwnerId: string;
  disposition: "inline" | "attachment";
  headOnly?: boolean;
}): Promise<Response> {
  const { request, trackId, appOwnerId, disposition, headOnly = false } = input;
  try {
    if (!Number.isSafeInteger(trackId) || trackId <= 0) {
      return mediaError("INVALID_TRACK_ID", "Track ID 无效", 400);
    }
    const track = getTrackById(trackId, appOwnerId);
    if (!track) {
      return mediaError("TRACK_NOT_FOUND", "Track 不存在", 404);
    }
    if (track.status !== "ready" || !track.kernelJobId || !track.artifactName) {
      return mediaError("TRACK_NOT_READY", "音频还没有准备好", 409, { "retry-after": "2" });
    }
    if (isTrackExpired(track)) {
      updateTrack(track.id, { status: "expired", failureReason: "音频缓存已过期" }, appOwnerId);
      return mediaError("TRACK_EXPIRED", "音频缓存已过期，请重新准备", 410);
    }

    const connectionTimeout = new AbortController();
    const timer = setTimeout(() => connectionTimeout.abort(), 15000);
    let upstream: Response;
    try {
      upstream = await fetch(
      kernelArtifactUrl(track.kernelJobId, track.artifactName, track.kernelOwnerId),
      {
        method: headOnly ? "HEAD" : "GET",
        cache: "no-store",
        headers: mediaRequestHeaders(request),
        signal: AbortSignal.any([request.signal, connectionTimeout.signal])
      }
      );
    } finally { clearTimeout(timer); }
    if (upstream.status === 404) {
      upstream.body?.cancel().catch(() => undefined);
      updateTrack(track.id, { status: "expired", failureReason: "kernel artifact not found" }, appOwnerId);
      return mediaError("TRACK_EXPIRED", "音频缓存已过期，请重新准备", 410);
    }
    if (!upstream.ok && ![206, 304, 416].includes(upstream.status)) {
      upstream.body?.cancel().catch(() => undefined);
      return mediaError("KERNEL_MEDIA_ERROR", `音频服务请求失败：HTTP ${upstream.status}`, 502);
    }

    const contentType = (upstream.headers.get("content-type") || track.artifactMimeType || "").toLowerCase();
    const multipartRange = upstream.status === 206 && contentType.startsWith("multipart/byteranges;");
    if ([200, 206].includes(upstream.status) && !contentType.startsWith("audio/") && !contentType.startsWith("application/octet-stream") && !multipartRange) {
      upstream.body?.cancel().catch(() => undefined);
      return mediaError("KERNEL_INVALID_MEDIA", "音频服务返回了非音频内容", 502);
    }
    const headers = mediaResponseHeaders(upstream.headers, track.artifactMimeType);
    headers.set("content-disposition", `${disposition}; ${contentDispositionAttachment(downloadFileName(track)).replace(/^attachment; /, "")}`);
    if (track.artifactSha256) {
      headers.set("x-content-sha256", track.artifactSha256);
      headers.set("etag", `"sha256-${track.artifactSha256}"`);
    }
    if (track.artifactSizeBytes !== null) {
      headers.set("x-file-size", String(track.artifactSizeBytes));
    }
    headers.set("x-track-id", String(track.id));
    if (track.expiresAt) headers.set("x-artifact-expires-at", track.expiresAt);
    headers.set("cross-origin-resource-policy", "same-origin");
    return new Response(headOnly ? null : upstream.body, {
      status: upstream.status,
      headers
    });
  } catch (error) {
    return mediaError("MEDIA_PROXY_FAILED", sanitizeText(error), 502);
  }
}

function mediaRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function mediaResponseHeaders(upstream: Headers, fallbackMimeType: string | null): Headers {
  const headers = new Headers();
  for (const name of MEDIA_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", fallbackMimeType || "audio/mp4");
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function mediaError(code: string, message: string, status: number, headers?: HeadersInit): Response {
  return NextResponse.json({ error: message, code }, { status, headers });
}
