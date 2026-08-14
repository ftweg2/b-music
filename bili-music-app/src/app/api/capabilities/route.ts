import { NextResponse } from "next/server";

import { apiCapabilities } from "@/lib/apiCapabilities";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(apiCapabilities(), {
    headers: { "cache-control": "public, max-age=300" }
  });
}
