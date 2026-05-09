import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";
import { providerMode } from "@/lib/search/provider";

export const runtime = "nodejs";

export function GET() {
  getDatabase();
  return NextResponse.json({
    status: "ok",
    app: process.env.NEXT_PUBLIC_APP_NAME || "bili-music-app",
    provider: providerMode(),
    metadataOnly: true
  });
}
