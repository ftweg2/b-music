import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { currentAppOwnerId } from "@/lib/appOwner";
import { deletePlaylist, editPlaylist, getPlaylistDetail, positiveId } from "@/lib/playlists";
import { playlistBody, playlistErrorResponse } from "@/lib/playlistApi";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

async function getHandler(_request: Request, { params }: Context) {
  try { return Response.json({ playlist: getPlaylistDetail(positiveId((await params).id), await currentAppOwnerId()) }); }
  catch (error) {
    if (error instanceof ApiError) throw error; return playlistErrorResponse(error); }
}
async function patchHandler(request: Request, { params }: Context) {
  try {
    const body = await playlistBody(request);
    return Response.json({ playlist: editPlaylist(positiveId((await params).id), await currentAppOwnerId(), body) });
  } catch (error) {
    if (error instanceof ApiError) throw error; return playlistErrorResponse(error); }
}
async function deleteHandler(_request: Request, { params }: Context) {
  try {
    deletePlaylist(positiveId((await params).id), await currentAppOwnerId());
    return Response.json({ deleted: true });
  } catch (error) {
    if (error instanceof ApiError) throw error; return playlistErrorResponse(error); }
}

export const GET = apiEndpoint("GET", getHandler);
export const PATCH = apiEndpoint("PATCH", patchHandler);
export const DELETE = apiEndpoint("DELETE", deleteHandler);
export const OPTIONS = apiOptions(["GET","PATCH","DELETE"]);
