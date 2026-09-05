import { apiEndpoint, apiOptions, ApiError, positiveId as apiPositiveId } from "@/lib/api";
import { currentAppOwnerId } from "@/lib/appOwner";
import { proxyTrackMedia } from "@/lib/trackMediaProxy";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

async function getHandler(request: Request, { params }: Params) {
  const { id } = await params;
  return proxyTrackMedia({
    request,
    trackId: apiPositiveId(id),
    appOwnerId: await currentAppOwnerId(),
    disposition: "inline"
  });
}

async function headHandler(request: Request, { params }: Params) {
  const { id } = await params;
  return proxyTrackMedia({
    request,
    trackId: apiPositiveId(id),
    appOwnerId: await currentAppOwnerId(),
    disposition: "inline",
    headOnly: true
  });
}

export const GET = apiEndpoint("GET", getHandler);
export const HEAD = apiEndpoint("HEAD", headHandler);
export const OPTIONS = apiOptions(["GET","HEAD"]);
