import { notFound } from "next/navigation";
import { currentAppOwnerId } from "@/lib/appOwner";
import { getPlaylistDetail, PlaylistError, positiveId } from "@/lib/playlists";
import { PlaylistDetailView } from "@/components/PlaylistDetailView";
export const dynamic = "force-dynamic";

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  try {
    return <PlaylistDetailView initialPlaylist={getPlaylistDetail(positiveId((await params).id), await currentAppOwnerId())} />;
  } catch (error) {
    if (error instanceof PlaylistError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }
}
