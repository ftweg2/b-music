import { NextResponse } from "next/server";

import { getDatabase, markExpiredReadyTracks } from "@/lib/db";
import { providerMode } from "@/lib/search/provider";
import { API_VERSION } from "@/lib/apiCapabilities";

export const runtime = "nodejs";

export function GET() {
  getDatabase();
  const expiredTracksMarked = markExpiredReadyTracks();
  return NextResponse.json({
    status: "ok",
    app: process.env.NEXT_PUBLIC_APP_NAME || "bili-music-app",
    apiVersion: API_VERSION,
    capabilitiesUrl: "/api/capabilities",
    provider: providerMode(),
    metadataOnly: true,
    expiredTracksMarked
  });
}
