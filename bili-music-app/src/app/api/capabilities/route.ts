import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { NextResponse } from "next/server";

import { apiCapabilities } from "@/lib/apiCapabilities";

export const runtime = "nodejs";

function getHandler() {
  return NextResponse.json(apiCapabilities(), {
    headers: { "cache-control": "public, max-age=300" }
  });
}

export const GET = apiEndpoint("GET", getHandler);
export const OPTIONS = apiOptions(["GET"]);
