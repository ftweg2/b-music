import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { NextResponse } from "next/server";

import { getKernelHealth } from "@/lib/kernelClient";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

async function getHandler() {
  try {
    return NextResponse.json(await getKernelHealth());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return NextResponse.json({ error: sanitizeText(error) }, { status: 502 });
  }
}

export const GET = apiEndpoint("GET", getHandler);
export const OPTIONS = apiOptions(["GET"]);
