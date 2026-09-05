import { ApiError, readJsonObject } from "./api";
import { PlaylistError } from "./playlists";

export function playlistErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) throw error;
  if (error instanceof PlaylistError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "请求内容不是有效的 JSON" }, { status: 400 });
  return Response.json({ error: "歌单操作失败，请稍后重试" }, { status: 500 });
}

export async function playlistBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await readJsonObject(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PlaylistError("无效的歌单请求");
  return body as Record<string, unknown>;
}
