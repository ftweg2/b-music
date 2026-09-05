import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { currentAppOwnerId } from "@/lib/appOwner";
import { positiveId, removePlaylistItem } from "@/lib/playlists";
import { playlistErrorResponse } from "@/lib/playlistApi";
export const runtime = "nodejs";

async function deleteHandler(_request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    removePlaylistItem(positiveId(id), await currentAppOwnerId(), positiveId(itemId));
    return Response.json({ removed: true });
  } catch (error) {
    if (error instanceof ApiError) throw error; return playlistErrorResponse(error); }
}

export const DELETE = apiEndpoint("DELETE", deleteHandler);
export const OPTIONS = apiOptions(["DELETE"]);
