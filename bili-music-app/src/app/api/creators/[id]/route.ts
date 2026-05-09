import { NextResponse } from "next/server";

import { editCreator, removeCreator } from "@/lib/creators";
import { currentAppOwnerId } from "@/lib/appOwner";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const creator = editCreator(Number(id), await request.json(), await currentAppOwnerId());
    if (!creator) {
      return NextResponse.json({ error: "关注 UP 不存在" }, { status: 404 });
    }
    return NextResponse.json({ creator });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const deleted = removeCreator(Number(id), await currentAppOwnerId());
  if (!deleted) {
    return NextResponse.json({ error: "关注 UP 不存在" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
