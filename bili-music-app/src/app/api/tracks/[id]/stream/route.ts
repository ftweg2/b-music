import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { getTrackById, updateTrack } from "@/lib/db";
import { kernelArtifactUrl } from "@/lib/kernelClient";
import { isTrackExpired } from "@/lib/tracks";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

const STREAM_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified"
];

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const appOwnerId = await currentAppOwnerId();
    const track = getTrackById(Number(id), appOwnerId);
    if (!track) {
      return NextResponse.json({ error: "Track 不存在" }, { status: 404 });
    }
    if (track.status !== "ready" || !track.kernelJobId || !track.artifactName) {
      return NextResponse.json({ error: "音频还没有准备好" }, { status: 409 });
    }
    if (isTrackExpired(track)) {
      updateTrack(track.id, { status: "expired", failureReason: "音频缓存已过期" }, appOwnerId);
      return NextResponse.json({ error: "音频缓存已过期，重新准备" }, { status: 410 });
    }

    const upstream = await fetch(kernelArtifactUrl(track.kernelJobId, track.artifactName), {
      cache: "no-store",
      headers: streamRequestHeaders(request)
    });
    if (upstream.status === 404) {
      updateTrack(track.id, { status: "expired", failureReason: "kernel artifact not found" }, appOwnerId);
      return NextResponse.json({ error: "音频缓存已过期，重新准备" }, { status: 410 });
    }

    const headers = streamResponseHeaders(upstream.headers, track.artifactMimeType);
    return new Response(upstream.body, {
      status: upstream.status,
      headers
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 502 });
  }
}

function streamRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) {
    headers.set("range", range);
  }
  return headers;
}

function streamResponseHeaders(upstream: Headers, fallbackMimeType: string | null): Headers {
  const headers = new Headers();
  for (const name of STREAM_HEADERS) {
    const value = upstream.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", fallbackMimeType || "audio/mp4");
  }
  if (!headers.has("accept-ranges")) {
    headers.set("accept-ranges", "bytes");
  }
  headers.set("cache-control", "no-store");
  return headers;
}
