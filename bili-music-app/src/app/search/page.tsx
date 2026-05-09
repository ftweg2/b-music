import { SearchBox } from "@/components/SearchBox";

export default function SearchPage() {
  return (
    <>
      <header className="pageHeader">
        <h2>发现音乐</h2>
        <p>只搜索和保存候选视频 metadata，不下载音频，不缓存页面。</p>
      </header>
      <SearchBox />
    </>
  );
}
