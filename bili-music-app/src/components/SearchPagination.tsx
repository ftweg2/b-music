"use client";

import { useEffect, useState } from "react";
import { pageNumbers } from "@/lib/search/pagination";

export function SearchPagination({ page, maximum, loading, hasNext, count, position, onPage }: {
  page: number; maximum: number; loading: boolean; hasNext: boolean; count: number;
  position: "top" | "bottom"; onPage: (page: number) => void;
}) {
  const [jump, setJump] = useState(String(page));
  useEffect(() => setJump(String(page)), [page]);
  const prefix = position === "top" ? "顶部" : "底部";
  function go(target: number) {
    if (!loading && Number.isInteger(target) && target >= 1 && target <= maximum && target !== page) onPage(target);
  }
  return <nav className="searchPager" aria-label={prefix + "搜索分页"}>
    <div className="searchPagerSummary"><span>第 <strong>{page}</strong> 页 · 本页 {count} 条</span><span>可浏览 1–{maximum} 页</span></div>
    <div className="searchPagerControls">
      <div className="searchPageNumbers">
        <button type="button" className="secondary pagerEdge" disabled={loading || page === 1} onClick={() => go(1)}>首页</button>
        <button type="button" className="secondary pagerDirection" disabled={loading || page === 1} aria-label="上一页" onClick={() => go(page - 1)}>‹</button>
        <div className="pageNumberSet desktopPageNumbers">{Array.from({ length: maximum }, (_, index) => index + 1).map((number) => <button type="button" key={number} className={"pageNumber " + (number === page ? "currentPage" : "secondary")} aria-label={`第 ${number} 页`} aria-current={number === page ? "page" : undefined} disabled={loading} onClick={() => go(number)}>{number}</button>)}</div>
        <div className="pageNumberSet compactPageNumbers">
        {pageNumbers(page, maximum).map((number, index) => number === "gap" ? <span className="pageGap" key={"gap-" + index}>…</span> : <button type="button" key={number} className={"pageNumber " + (number === page ? "currentPage" : "secondary")} aria-label={`第 ${number} 页`} aria-current={number === page ? "page" : undefined} disabled={loading} onClick={() => go(number)}>{number}</button>)}
        </div>
        <button type="button" className="secondary pagerDirection" disabled={loading || !hasNext || page >= maximum} aria-label="下一页" onClick={() => go(page + 1)}>›</button>
        <button type="button" className="secondary pagerEdge" disabled={loading || page >= maximum} onClick={() => go(maximum)}>末页</button>
      </div>
      <form className="pageJump" onSubmit={(event) => { event.preventDefault(); go(Number(jump)); }}>
        <label htmlFor={position + "-page-jump"}>跳至</label>
        <input id={position + "-page-jump"} aria-label={prefix + "跳转页码"} inputMode="numeric" type="number" min={1} max={maximum} step={1} required value={jump} disabled={loading} onChange={(event) => setJump(event.target.value)} />
        <span>页</span><button type="submit" className="secondary" disabled={loading}>跳转</button>
      </form>
    </div>
  </nav>;
}
