import type { PreferredCreator } from "../models";

export type SearchOptions = {
  limit: number;
  page: number;
  timeoutMs: number;
  externalOwnerId?: string;
  profileId?: string;
};

export type RefreshOptions = {
  limit: number;
  timeoutMs: number;
};

export type RawSearchResult = {
  bvid: string;
  aid?: string | number | null;
  title: string;
  description?: string | null;
  creatorMid?: string | number | null;
  creatorName?: string | null;
  coverUrl?: string | null;
  durationSeconds?: number | null;
  pubTime?: string | number | null;
  sourceUrl?: string | null;
  category?: string | null;
  tags?: string[];
};

export interface SearchProvider {
  name: string;
  supportsConcurrentSearch?: boolean;
  searchVideos(keyword: string, options: SearchOptions): Promise<RawSearchResult[]>;
  refreshCreatorLatest?(creator: PreferredCreator, options: RefreshOptions): Promise<RawSearchResult[]>;
}

export type NormalizedCandidate = {
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
  tags: string[];
  searchKeyword: string | null;
  sourceProvider: string;
};
