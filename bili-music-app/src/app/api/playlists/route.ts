import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { currentAppOwnerId } from "@/lib/appOwner";
import { createPlaylist, listPlaylists } from "@/lib/playlists";
import { playlistBody, playlistErrorResponse } from "@/lib/playlistApi";
export const runtime = "nodejs";

async function getHandler() {
  try { return Response.json({ playlists: listPlaylists(await currentAppOwnerId()) }); }
  catch (error) {
    if (error instanceof ApiError) throw error; return playlistErrorResponse(error); }
}
async function postHandler(request: Request) {
  try {
    const body = await playlistBody(request);
    const playlist = createPlaylist(await currentAppOwnerId(), { name: body.name, description: body.description, candidateId: body.candidateId }, request.headers.get("idempotency-key") || undefined);
    return Response.json({ playlist }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) throw error; return playlistErrorResponse(error); }
}

export const GET = apiEndpoint("GET", getHandler);
export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["GET","POST"]);
