import type { RawSearchResult, SearchOptions, SearchProvider } from "./types";

const FIXED_RESULTS: RawSearchResult[] = [
  {
    bvid: "BV1mock0001A",
    aid: "1001",
    title: "夜航星 原创曲 MV",
    description: "用于音乐发现测试的稳定 mock 候选。",
    creatorMid: "111111",
    creatorName: "星海音乐社",
    coverUrl: null,
    durationSeconds: 264,
    pubTime: "2026-04-12T10:00:00.000Z",
    sourceUrl: "https://www.bilibili.com/video/BV1mock0001A",
    category: "音乐",
    tags: ["原创曲", "MV", "音乐"]
  },
  {
    bvid: "BV1mock0002B",
    aid: "1002",
    title: "夜航星 cover / piano live",
    description: "钢琴翻奏 live 版本。",
    creatorMid: "222222",
    creatorName: "键盘上的风",
    coverUrl: null,
    durationSeconds: 318,
    pubTime: "2025-12-08T10:00:00.000Z",
    sourceUrl: "https://www.bilibili.com/video/BV1mock0002B",
    category: "音乐",
    tags: ["cover", "live", "instrumental"]
  },
  {
    bvid: "BV1mock0003C",
    aid: "1003",
    title: "夜航星 剧情解析 reaction",
    description: "非音乐候选，应被音乐启发式降权。",
    creatorMid: "333333",
    creatorName: "影像观察室",
    coverUrl: null,
    durationSeconds: 1800,
    pubTime: "2026-01-20T10:00:00.000Z",
    sourceUrl: "https://www.bilibili.com/video/BV1mock0003C",
    category: "影视",
    tags: ["解析", "reaction"]
  },
  {
    bvid: "BV1mock0004D",
    aid: "1004",
    title: "原创音乐合集：夜航星与远方",
    description: "音乐相关长合集，时长偏长所以会被轻微降权。",
    creatorMid: "111111",
    creatorName: "星海音乐社",
    coverUrl: null,
    durationSeconds: 3900,
    pubTime: "2024-11-01T10:00:00.000Z",
    sourceUrl: "https://www.bilibili.com/video/BV1mock0004D",
    category: "音乐",
    tags: ["原创曲", "歌曲"]
  }
];

export const mockProvider: SearchProvider = {
  name: "mock",
  async searchVideos(keyword: string, options: SearchOptions): Promise<RawSearchResult[]> {
    const normalized = keyword.trim().toLowerCase();
    const matches = FIXED_RESULTS.filter((item) => {
      const text = `${item.title} ${item.description ?? ""} ${(item.tags ?? []).join(" ")}`.toLowerCase();
      return !normalized || text.includes(normalized) || normalized.includes("night") || normalized.includes("夜航星");
    });
    const page = Math.max(1, Math.round(options.page || 1));
    const start = (page - 1) * options.limit;
    return matches.slice(start, start + options.limit);
  },
  async refreshCreatorLatest(creator, options): Promise<RawSearchResult[]> {
    return FIXED_RESULTS.filter((item) => String(item.creatorMid) === creator.biliMid).slice(0, Math.min(options.limit, 5));
  }
};
