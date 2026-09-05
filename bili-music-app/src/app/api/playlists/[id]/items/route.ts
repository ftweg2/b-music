import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { currentAppOwnerId } from "@/lib/appOwner";
import { addPlaylistItem, reorderPlaylist, positiveId } from "@/lib/playlists";
import { playlistBody, playlistErrorResponse } from "@/lib/playlistApi";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

async function postHandler(request: Request, { params }: Context) {
  try {
    const body = await playlistBody(request);
    return Response.json(addPlaylistItem(positiveId((await params).id), await currentAppOwnerId(), body.candidateId));
  } catch (error) {
    if (error instanceof ApiError) throw error; return playlistErrorResponse(error); }
}
async function patchHandler(request: Request, { params }: Context) {
  try {
    const body = await playlistBody(request);
    reorderPlaylist(positiveId((await params).id), await currentAppOwnerId(), body.itemIds);
    return Response.json({ reordered: true });
  } catch (error) {
    if (error instanceof ApiError) throw error; return playlistErrorResponse(error); }
}

export const POST = apiEndpoint("POST", postHandler);
export const PATCH = apiEndpoint("PATCH", patchHandler);
export const OPTIONS = apiOptions(["POST","PATCH"]);
