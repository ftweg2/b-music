"use client";

import { useEffect, useState, type FormEvent } from "react";

import type { CandidateWithScore } from "@/lib/models";
import { CandidateList } from "./CandidateList";
import { KernelLoginPanel } from "./KernelLoginPanel";

type ProviderChoice = "bilibili" | "kernel";

type StoredSearchState = {
  keyword: string;
  useRemote: boolean;
  provider: ProviderChoice;
  externalOwnerId: string;
  profileId: string;
  limit: number;
  page: number;
  hasNextPage: boolean;
  message: string;
  candidates: CandidateWithScore[];
  updatedAt: string;
};

const SEARCH_STATE_KEY = "bili-music-app:search-state:v3";

export function SearchBox() {
  const [keyword, setKeyword] = useState("");
  const [useRemote, setUseRemote] = useState(true);
  const [provider, setProvider] = useState<ProviderChoice>("bilibili");
  const [externalOwnerId, setExternalOwnerId] = useState("local");
  const [profileId, setProfileId] = useState("");
  const [limit, setLimit] = useState(20);
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [candidates, setCandidates] = useState<CandidateWithScore[]>([]);

  useEffect(() => {
    const saved = readStoredSearchState();
    const params = new URLSearchParams(window.location.search);
    const fromUrl = searchStateFromParams(params);
    const next = fromUrl ?? normalizeStoredSearchState(saved);
    if (!next) {
      return;
    }
    const savedMatches = Boolean(saved && sameSearchIdentity(saved, next));
    setKeyword(next.keyword);
    setUseRemote(next.useRemote);
    setProvider(next.provider);
    setExternalOwnerId(next.externalOwnerId);
    setProfileId(next.profileId);
    setLimit(next.limit);
    setPage(next.page);
    setHasNextPage(savedMatches ? saved?.hasNextPage ?? next.hasNextPage : false);
    setMessage(savedMatches ? saved?.message ?? next.message : "已从 URL 恢复搜索条件，点击“开始发现”可重新拉取结果。");
    setCandidates(savedMatches ? saved?.candidates ?? [] : []);
  }, []);

  useEffect(() => {
    if (provider !== "kernel") {
      return;
    }
    const savedOwnerId = window.localStorage.getItem("kernel_external_owner_id");
    const savedProfileId = window.localStorage.getItem("kernel_profile_id");
    if (savedOwnerId && externalOwnerId === "local") {
      setExternalOwnerId(savedOwnerId);
    }
    if (savedProfileId && !profileId) {
      setProfileId(savedProfileId);
    }
  }, [provider, externalOwnerId, profileId]);

  async function search(event?: FormEvent<HTMLFormElement>, requestedPage = 1) {
    event?.preventDefault();
    const cleanKeyword = keyword.trim();
    const safeLimit = clampLimit(limit);
    const safePage = clampPage(requestedPage);
    if (!cleanKeyword) {
      setMessage("先输入一个关键词，再开始发现。");
      return;
    }
    setLoading(true);
    setMessage("");
    setLimit(safeLimit);
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keyword: cleanKeyword,
          useRemote,
          limit: safeLimit,
          page: safePage,
          provider,
          externalOwnerId,
          profileId
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "搜索失败");
      }
      const nextCandidates = payload.candidates || [];
      const nextPage = Number(payload.page || safePage);
      const nextHasNextPage = Boolean(payload.hasNextPage);
      const nextMessage =
        `第 ${nextPage} 页 · 搜索源：${payload.provider}；${payload.remoteUsed ? "已请求搜索源" : "仅使用本地缓存"}${
          payload.providerError ? `；提示：${payload.providerError}` : ""
        }`;
      setCandidates(nextCandidates);
      setMessage(nextMessage);
      setPage(nextPage);
      setHasNextPage(nextHasNextPage);
      const nextState = {
        keyword: cleanKeyword,
        useRemote,
        provider,
        externalOwnerId,
        profileId,
        limit: safeLimit,
        page: nextPage,
        hasNextPage: nextHasNextPage,
        message: nextMessage,
        candidates: nextCandidates,
        updatedAt: new Date().toISOString()
      };
      writeStoredSearchState(nextState);
      replaceSearchUrl(nextState);
    } catch (error) {
      setMessage(String(error instanceof Error ? error.message : error));
    } finally {
      setLoading(false);
    }
  }

  function goToPage(nextPage: number) {
    void search(undefined, nextPage);
  }

  return (
    <>
      <section className="panel searchPanel">
        <form onSubmit={(event) => void search(event, 1)}>
          <div className="searchPrimary">
            <label className="keywordField">
              关键词
              <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="比如：花之舞 / 洛天依 / cover" />
            </label>
            <button className="searchButton" type="submit" disabled={loading}>
              {loading ? "搜索中..." : "开始发现"}
            </button>
          </div>

          <div className="searchOptions">
            <label>
              搜索源
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as ProviderChoice)}
                disabled={!useRemote}
              >
                <option value="bilibili">Bilibili 普通搜索</option>
                <option value="kernel">内核登录态搜索</option>
              </select>
            </label>
            <label>
              搜索范围
              <select value={useRemote ? "yes" : "no"} onChange={(event) => setUseRemote(event.target.value === "yes")}>
                <option value="yes">本地缓存 + 搜索源</option>
                <option value="no">只看本地缓存</option>
              </select>
            </label>
            <label className="compactField">
              数量
              <input type="number" min={1} max={50} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
            </label>
          </div>

          {useRemote && provider === "kernel" ? (
            <div className="kernelInline">
              <label>
                外部用户/团队 ID
                <input
                  value={externalOwnerId}
                  onChange={(event) => setExternalOwnerId(event.target.value)}
                />
              </label>
              <label>
                Kernel profile_id
                <input
                  value={profileId}
                  onChange={(event) => setProfileId(event.target.value)}
                  placeholder="p_xxx"
                />
              </label>
              <p className="note">内核登录态搜索只把 owner/profile 传给 kernel，Cookie 不会回到 App。</p>
            </div>
          ) : null}

          {message ? <p className="note searchMessage">{message}</p> : null}
        </form>
      </section>

      {provider === "kernel" && useRemote ? (
        <KernelLoginPanel
          externalOwnerId={externalOwnerId}
          profileId={profileId}
          onExternalOwnerIdChange={setExternalOwnerId}
          onProfileIdChange={setProfileId}
        />
      ) : null}

      <CandidateList candidates={candidates} />

      {candidates.length ? (
        <nav className="paginationBar" aria-label="搜索结果分页">
          <button type="button" className="secondary" onClick={() => goToPage(page - 1)} disabled={loading || page <= 1}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button type="button" onClick={() => goToPage(page + 1)} disabled={loading || !hasNextPage}>
            下一页
          </button>
        </nav>
      ) : null}
    </>
  );
}

function readStoredSearchState(): StoredSearchState | null {
  try {
    const raw = window.sessionStorage.getItem(SEARCH_STATE_KEY);
    return raw ? normalizeStoredSearchState(JSON.parse(raw) as StoredSearchState) : null;
  } catch {
    return null;
  }
}

function writeStoredSearchState(state: StoredSearchState): void {
  try {
    window.sessionStorage.setItem(SEARCH_STATE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort UX cache only.
  }
}

function searchStateFromParams(params: URLSearchParams): StoredSearchState | null {
  const keyword = params.get("q")?.trim();
  if (!keyword) {
    return null;
  }
  const provider = normalizeProvider(params.get("provider"));
  return {
    keyword,
    useRemote: params.get("remote") !== "0",
    provider,
    externalOwnerId: params.get("owner") || "local",
    profileId: params.get("profile") || "",
    limit: clampLimit(Number(params.get("limit") || 20)),
    page: clampPage(Number(params.get("page") || 1)),
    hasNextPage: false,
    message: "已恢复上一次搜索条件。结果列表来自本页会话缓存。",
    candidates: [],
    updatedAt: new Date().toISOString()
  };
}

function replaceSearchUrl(state: StoredSearchState): void {
  const params = new URLSearchParams();
  params.set("q", state.keyword);
  params.set("remote", state.useRemote ? "1" : "0");
  params.set("provider", state.provider);
  params.set("limit", String(state.limit));
  if (state.page > 1) {
    params.set("page", String(state.page));
  }
  if (state.provider === "kernel") {
    params.set("owner", state.externalOwnerId);
    if (state.profileId) {
      params.set("profile", state.profileId);
    }
  }
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

function normalizeProvider(value: string | null): ProviderChoice {
  return value === "kernel" ? "kernel" : "bilibili";
}

function normalizeStoredSearchState(state: StoredSearchState | null): StoredSearchState | null {
  return state
    ? {
        ...state,
        provider: normalizeProvider(state.provider),
        page: clampPage(Number(state.page || 1)),
        hasNextPage: Boolean(state.hasNextPage)
      }
    : null;
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(Number.isFinite(value) ? Math.round(value) : 20, 50));
}

function clampPage(value: number): number {
  return Math.max(1, Math.min(Number.isFinite(value) ? Math.round(value) : 1, 10));
}

function sameSearchIdentity(left: StoredSearchState, right: StoredSearchState): boolean {
  return (
    left.keyword === right.keyword &&
    left.useRemote === right.useRemote &&
    left.provider === right.provider &&
    left.externalOwnerId === right.externalOwnerId &&
    left.profileId === right.profileId &&
    left.limit === right.limit &&
    left.page === right.page
  );
}
