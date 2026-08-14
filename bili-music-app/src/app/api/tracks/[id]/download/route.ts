import { currentAppOwnerId } from "@/lib/appOwner";
import { proxyTrackMedia } from "@/lib/trackMediaProxy";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return proxyTrackMedia({
    request,
    trackId: Number(id),
    appOwnerId: await currentAppOwnerId(),
    disposition: "attachment"
  });
}

export async function HEAD(request: Request, { params }: Params) {
  const { id } = await params;
  return proxyTrackMedia({
    request,
    trackId: Number(id),
    appOwnerId: await currentAppOwnerId(),
    disposition: "attachment",
    headOnly: true
  });
}
