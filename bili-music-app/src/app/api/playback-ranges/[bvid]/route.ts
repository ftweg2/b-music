import { apiEndpoint, apiOptions, readJsonObject } from "@/lib/api";
import { currentAppOwnerId } from "@/lib/appOwner";
import { playbackBvid, readPlaybackRange, savePlaybackRange } from "@/lib/playbackRanges";

export const runtime = "nodejs";
type Context = { params: Promise<{ bvid: string }> };

export const GET = apiEndpoint("GET", async (_request: Request, context: Context) => {
  const bvid = playbackBvid((await context.params).bvid);
  return Response.json({ playbackRange: readPlaybackRange(bvid, await currentAppOwnerId()) });
});
export const PATCH = apiEndpoint("PATCH", async (request: Request, context: Context) => {
  const bvid = playbackBvid((await context.params).bvid);
  const body = await readJsonObject(request);
  return Response.json({ playbackRange: savePlaybackRange(bvid, await currentAppOwnerId(), body) });
});
export const OPTIONS = apiOptions(["GET", "PATCH"]);
