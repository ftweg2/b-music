import { currentAppOwnerId } from "@/lib/appOwner";
import { listPlaylists } from "@/lib/playlists";
import { PlaylistLibrary } from "@/components/PlaylistLibrary";
export const dynamic = "force-dynamic";

export default async function PlaylistsPage() {
  return <PlaylistLibrary initialPlaylists={listPlaylists(await currentAppOwnerId())} />;
}
