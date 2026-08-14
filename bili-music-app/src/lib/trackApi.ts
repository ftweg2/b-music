import type { Track } from "./models";

export type TrackMediaLinks = {
  streamUrl: string | null;
  downloadUrl: string | null;
  checksum: { algorithm: "sha-256"; value: string } | null;
  sizeBytes: number | null;
  mimeType: string | null;
  fileName: string | null;
  expiresAt: string | null;
  resumable: boolean;
};

export type TrackApiResource = Omit<Track, "kernelOwnerId"> & {
  media: TrackMediaLinks;
};

export function toTrackApiResource(track: Track): TrackApiResource {
  const { kernelOwnerId: _kernelOwnerId, ...publicTrack } = track;
  const ready = track.status === "ready" && Boolean(track.kernelJobId && track.artifactName);
  const base = `/api/tracks/${track.id}`;
  return {
    ...publicTrack,
    media: {
      streamUrl: ready ? `${base}/stream` : null,
      downloadUrl: ready ? `${base}/download` : null,
      checksum: track.artifactSha256
        ? { algorithm: "sha-256", value: track.artifactSha256 }
        : null,
      sizeBytes: track.artifactSizeBytes,
      mimeType: track.artifactMimeType,
      fileName: ready ? downloadFileName(track) : null,
      expiresAt: track.expiresAt,
      resumable: ready
    }
  };
}

export function downloadFileName(track: Pick<Track, "title" | "bvid" | "artifactName" | "artifactMimeType">): string {
  const extension = mediaExtension(track.artifactName, track.artifactMimeType);
  const safeTitle = track.title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  const base = safeTitle || track.bvid || "audio";
  return `${base} - ${track.bvid}.${extension}`;
}

export function contentDispositionAttachment(fileName: string): string {
  const asciiFallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180) || "audio.m4a";
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function mediaExtension(artifactName: string | null, mimeType: string | null): string {
  const match = artifactName?.match(/\.([A-Za-z0-9]{1,8})$/);
  if (match && /^(m4a|mp3|aac|flac|ogg|opus|wav)$/i.test(match[1])) {
    return match[1].toLowerCase();
  }
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("flac")) return "flac";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  return "m4a";
}
