"use client";
import { accountFetch } from "@/lib/accountClient";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ACCOUNT_CHANGE_EVENT } from "@/lib/accountEvents";
import { LIBRARY_CHANGE_EVENT, type LibraryChange } from "@/lib/libraryEvents";
import { followedFirst } from "@/lib/search/order";
import {
  SEARCH_STATE_KEY, bindSearchResult, failedSearchAttempt, pageAttempt, positiveInteger, searchEntry, searchUrl, sameSearch, normalizeSearchSnapshot,
  type ProviderChoice, type SearchAttempt, type SearchSnapshot, type SearchPayload,
} from "@/lib/search/state";
import { CandidateList } from "./CandidateList";
import { SearchPagination } from "./SearchPagination";
import { SearchIcon, CloseIcon, FilterIcon, RefreshIcon } from "./Icons";

const SUGGESTIONS = ["周杰伦", "陈奕迅", "纯音乐 治愈", "粤语经典", "爵士轻音乐"];
const sourceLabel = (snapshot: SearchSnapshot) => snapshot.source === "direct" ? "视频链接" : snapshot.source === "local" ? "本地音乐记录" : snapshot.request.provider === "kernel" ? "登录态搜索" : "普通在线搜索";

export function SearchBox({ initialQuery = "" }: { initialQuery?: string }) {
  const entry = searchEntry(initialQuery);
  const [keyword, setKeyword] = useState(entry.request.keyword);
  const [useRemote, setUseRemote] = useState(entry.request.useRemote);
  const [provider, setProvider] = useState<ProviderChoice>(entry.request.provider);
  const [limit, setLimit] = useState(entry.request.limit);
  const [result, setResult] = useState<SearchSnapshot | null>(null);
  const [failure, setFailure] = useState<{ request: SearchAttempt; message: string; sessionChanged?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);

  async function execute(request: SearchAttempt, scrollToResults = false) {
    if (!request.keyword.trim()) { setNotice("请输入歌曲、歌手或 UP 主关键词"); input.current?.focus(); return; }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true); setFailure(null); setNotice("");
    // Drop one-shot navigation intent before requesting, so refresh cannot silently repeat a search.
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.has("run")) { currentUrl.searchParams.delete("run"); window.history.replaceState(null, "", currentUrl.pathname + currentUrl.search); }
    try {
      const response = await accountFetch("/api/search", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(request), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
      });
      const data = await response.json();
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const message = String(data.error || "搜索失败") + (response.status === 429 ? "；请稍后再试" : "");
        setFailure({ request: failedSearchAttempt(request, data), message, sessionChanged: data.code === "SEARCH_SESSION_CHANGED" || data.code === "SEARCH_SNAPSHOT_EXPIRED" });
        if (data.code === "SEARCH_SESSION_CHANGED" || data.code === "SEARCH_SNAPSHOT_EXPIRED") { setResult(null); clearSaved(); }
        return;
      }
      const snapshot = bindSearchResult(request, data as SearchPayload);
      setResult(snapshot); save(snapshot);
      setLimit(snapshot.request.limit);
      window.history.replaceState(null, "", searchUrl(snapshot.request));
      if (scrollToResults) window.requestAnimationFrame(() => document.getElementById("search-results-start")?.scrollIntoView({ block: "start", behavior: "auto" }));
    } catch (error) {
      if (!controller.signal.aborted) setFailure({ request, message: error instanceof Error && error.name === "TimeoutError" ? "搜索超时，请重试；没有切换来源" : "请求未完成，请检查连接后重试" });
    } finally {
      if (pending.current === controller) setLoading(false);
    }
  }

  useEffect(() => {
    const parsed = searchEntry(initialQuery);
    const saved = readSaved();
    const restored = !parsed.run && saved && (!parsed.request.keyword || sameSearch(saved.request, parsed.request)) ? saved : null;
    const selected = restored?.request ?? parsed.request;
    setKeyword(selected.keyword); setUseRemote(selected.useRemote); setProvider(selected.provider); setLimit(selected.limit);
    setResult(restored); setFailure(null);
    if (selected.keyword && !restored && !parsed.run) setNotice("已恢复搜索条件，点击搜索获取结果");
    const timer = parsed.run ? window.setTimeout(() => void execute({ ...parsed.request, page: 1, sessionKey: undefined, searchId: undefined }), 0) : null;
    return () => { if (timer !== null) window.clearTimeout(timer); pending.current?.abort(); };
  }, [initialQuery]);

  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); input.current?.focus(); }
    };
    const accountChange = () => {
      pending.current?.abort(); setLoading(false); setResult(null); setFailure(null); clearSaved();
      setProvider("auto"); setNotice("登录状态已变化，请重新搜索；本地收藏和歌单不受影响");
    };
    const libraryChange = (event: Event) => {
      const update = (event as CustomEvent<LibraryChange>).detail;
      setResult((previous) => {
        if (!previous) return previous;
        const candidates = followedFirst(previous.candidates.map((item) => {
          if (update.kind === "favorite" && item.bvid === update.bvid) return { ...item, isFavorited: update.favorited };
          if (update.kind === "creator" && item.creatorMid === update.biliMid) return { ...item, isPreferredCreator: update.followed };
          return item;
        }), (item) => item.isPreferredCreator);
        const next = { ...previous, candidates }; save(next); return next;
      });
    };
    window.addEventListener("keydown", focus);
    window.addEventListener(ACCOUNT_CHANGE_EVENT, accountChange);
    window.addEventListener(LIBRARY_CHANGE_EVENT, libraryChange);
    return () => {
      window.removeEventListener("keydown", focus); window.removeEventListener(ACCOUNT_CHANGE_EVENT, accountChange); window.removeEventListener(LIBRARY_CHANGE_EVENT, libraryChange);
    };
  }, []);

  const freshRequest = (value = keyword): SearchAttempt => ({
    keyword: value.trim(), useRemote, provider, limit: positiveInteger(limit, 20, useRemote ? 20 : 50), page: 1,
  });
  function begin(value = keyword) { setKeyword(value); void execute(freshRequest(value)); }
  function pagination(position: "top" | "bottom") {
    return result ? <SearchPagination page={result.request.page} maximum={result.pageLimit} hasNext={result.hasNextPage}
      loading={loading} count={result.candidates.length} position={position}
      onPage={(page) => void execute(pageAttempt(result, page), true)} /> : null;
  }

  return <>
    <section className="searchHero" aria-label="音乐搜索">
      <form onSubmit={(event) => { event.preventDefault(); begin(); }}>
        <div className="searchHeroTop">
          <div className="searchBarWrapper"><SearchIcon size={18} className="searchBarIcon" />
            <input ref={input} className="searchHeroInput" aria-label="搜索歌曲名、歌手、UP 主或 BV 号" placeholder="搜索歌曲、歌手、UP 主或 BV 号" maxLength={200} value={keyword} disabled={loading} onChange={(event) => setKeyword(event.target.value)} />
            {keyword ? <button type="button" className="searchClearBtn" aria-label="清空搜索词" disabled={loading} onClick={() => setKeyword("")}><CloseIcon size={14} /></button> : <kbd className="searchShortcut">Ctrl K</kbd>}
          </div>
          <button type="submit" className="searchSubmit" disabled={loading}>{loading ? <RefreshIcon className="playerDiscSpin" size={16} /> : <SearchIcon size={16} />}{loading ? "搜索中" : "搜索"}</button>
          <button type="button" className="secondary searchFilterToggle" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters} aria-controls="search-filters"><FilterIcon size={17} /><span>筛选</span></button>
        </div>
        <div className="quickFilters"><span className="quickFilterLabel">试试搜索</span>{SUGGESTIONS.map((word) => <button key={word} type="button" className="filterPill" disabled={loading} onClick={() => begin(word)}>{word}</button>)}</div>
        {showFilters && <div className="advancedPanel" id="search-filters">
          <label className="filterField"><span>搜索范围</span><select value={useRemote ? "online" : "local"} disabled={loading} onChange={(event) => setUseRemote(event.target.value === "online")}><option value="online">在线搜索</option><option value="local">仅查本地音乐记录</option></select></label>
          <label className="filterField"><span>在线来源</span><select value={provider} disabled={loading || !useRemote} onChange={(event) => setProvider(event.target.value as ProviderChoice)}><option value="auto">自动选择（登录后优先登录态）</option><option value="kernel">内核登录态搜索</option><option value="bilibili">普通接口搜索</option></select></label>
          <label className="filterField"><span>每页数量</span><input type="number" min={1} max={useRemote ? 20 : 50} value={limit} disabled={loading} onChange={(event) => setLimit(Number(event.target.value))} /></label>
        </div>}
      </form>
      <div className="searchSourceHelp"><span>{result ? `当前结果：${sourceLabel(result)} · 已关注 UP 优先` : "新搜索自动选择来源，翻页不切换来源"}{result?.selectionNote ? ` · ${result.selectionNote}` : ""}</span><Link href="/settings" className="textLink">账号与登录 ↗</Link></div>
      {notice && <p className="note" role="status">{notice}</p>}
    </section>
    {failure && <section className="searchFailure" role="alert">
      <strong>“{failure.request.keyword}”第 {failure.request.page} 页未加载{result ? `，仍显示“${result.request.keyword}”第 ${result.request.page} 页` : ""}</strong>
      <p>来源：{failure.request.useRemote ? failure.request.provider === "kernel" ? "登录态搜索" : failure.request.provider === "bilibili" ? "普通在线搜索" : "自动选择" : "本地音乐记录"}。{failure.message}</p>
      <div className="row"><button type="button" disabled={loading} onClick={() => void execute(failure.sessionChanged ? { ...failure.request, provider: "auto", page: 1, sessionKey: undefined, searchId: undefined } : failure.request)}>{failure.sessionChanged ? "从第一页重新搜索" : "重试这一页"}</button>
        {failure.request.useRemote && <button type="button" className="secondary" disabled={loading} onClick={() => { setUseRemote(false); void execute({ ...failure.request, useRemote: false, provider: "bilibili", page: 1, sessionKey: undefined, searchId: undefined }); }}>改查本地（从第一页开始）</button>}
      </div>
    </section>}
    <div id="search-results-start" />
    {pagination("top")}
    {result && <p className="searchSnapshotNote" role="status">本次搜索的已访问页已固定，不重新混排。{result.duplicatesRemoved > 0 ? `本页已去除 ${result.duplicatesRemoved} 条重复曲目，不跨页补位。` : "同一 BV 只出现一次。"}<button className="textLink" type="button" disabled={loading} onClick={() => void execute({ ...result.request, provider: "auto", page: 1, sessionKey: undefined, searchId: undefined }, true)}>重新搜索</button></p>}
    {loading && <div className="searchLoading" role="status"><RefreshIcon size={22} className="playerDiscSpin" /><strong>正在加载搜索结果</strong><button type="button" className="textLink" onClick={() => { pending.current?.abort(); setLoading(false); setNotice("已取消请求，已有结果保留"); }}>取消等待</button></div>}
    {result ? <CandidateList candidates={result.candidates} title={`“${result.request.keyword}”的搜索结果`} emptyTitle={result.duplicatesRemoved > 0 ? "本页曲目已在访问过的页面出现" : "这一页没有结果"} emptyDescription="可以点击页码前往其他页，或重新搜索更新结果。" /> : !loading && !failure ? <div className="empty"><div className="emptyIcon"><SearchIcon size={26} /></div><strong>想听的，都从这里开始</strong><span>输入关键词，结果与分页都在这个页面完成。</span></div> : null}
    {result ? pagination("bottom") : null}
  </>;
}

function readSaved(): SearchSnapshot | null {
  try { return normalizeSearchSnapshot(JSON.parse(window.sessionStorage.getItem(SEARCH_STATE_KEY) || "null")); } catch { return null; }
}
function save(snapshot: SearchSnapshot) { try { window.sessionStorage.setItem(SEARCH_STATE_KEY, JSON.stringify(snapshot)); } catch { /* Metadata cache is best effort. */ } }
function clearSaved() { try { window.sessionStorage.removeItem(SEARCH_STATE_KEY); } catch { /* Storage may be disabled. */ } }
