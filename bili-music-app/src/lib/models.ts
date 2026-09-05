export type InteractionAction = "viewed" | "liked" | "disliked" | "skipped" | "queued" | "extraction_failed";
export type TrackStatus = "pending" | "preparing" | "ready" | "expired" | "failed";

export type PreferredCreator = {
  id: number;
  externalOwnerId: string;
  biliMid: string;
  name: string;
  homepageUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CandidateVideo = {
  id: number;
  bvid: string;
  aid: string | null;
  title: string;
  description: string | null;
  creatorMid: string | null;
  creatorName: string | null;
  coverUrl: string | null;
  durationSeconds: number | null;
  pubTime: string | null;
  sourceUrl: string;
  category: string | null;
  tagsJson: string | null;
  searchKeyword: string | null;
  sourceProvider: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CandidateInteraction = {
  id: number;
  externalOwnerId: string;
  candidateId: number;
  action: InteractionAction;
  createdAt: string;
};

export type FavoriteVideo = {
  id: number;
  externalOwnerId: string;
  candidateId: number | null;
  bvid: string;
  note: string | null;
  mood: string | null;
  titleSnapshot: string;
  sourceUrlSnapshot: string;
  creatorMidSnapshot: string | null;
  creatorNameSnapshot: string | null;
  coverUrlSnapshot: string | null;
  durationSecondsSnapshot: number | null;
  pubTimeSnapshot: string | null;
  categorySnapshot: string | null;
  tagsJsonSnapshot: string | null;
  snapshotQuality: "minimal" | "partial" | "complete";
  lastHydratedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Track = {
  id: number;
  externalOwnerId: string;
  kernelOwnerId: string;
  candidateId: number;
  bvid: string;
  title: string;
  sourceUrl: string;
  kernelJobId: string | null;
  artifactName: string | null;
  artifactSha256: string | null;
  artifactSizeBytes: number | null;
  artifactMimeType: string | null;
  durationSeconds: number | null;
  status: TrackStatus;
  failureReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SearchQueryLog = {
  id: number;
  keyword: string;
  resultCount: number;
  remoteUsed: boolean;
  createdAt: string;
};

export type CandidateItem = CandidateVideo & {
  tags: string[];
  isPreferredCreator: boolean;
  isFavorited: boolean;
};

export type CreatePreferredCreatorInput = {
  externalOwnerId?: string;
  biliMid: string;
  name: string;
  homepageUrl?: string | null;
  notes?: string | null;
};

export type Playlist = {
  id: number;
  name: string;
  description: string;
  trackCount: number;
  coverUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlaylistItem = {
  id: number;
  position: number;
  addedAt: string;
  candidate: CandidateItem;
};

export type PlaylistDetail = Playlist & { items: PlaylistItem[] };
