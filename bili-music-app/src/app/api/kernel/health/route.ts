import { NextResponse } from "next/server";

import { getKernelHealth } from "@/lib/kernelClient";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await getKernelHealth());
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 502 });
  }
}
