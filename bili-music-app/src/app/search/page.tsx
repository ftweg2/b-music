import { SearchBox } from "@/components/SearchBox";
import { CompassIcon } from "@/components/Icons";

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["q", "remote", "provider", "limit", "page", "run", "searchId", "sessionKey"]) if (typeof query[key] === "string") params.set(key, query[key]);
  return (
    <>
      <header className="pageHeader">
        <div className="pageTitleRow">
          <div className="pageIcon lime">
            <CompassIcon size={20} />
          </div>
          <span className="sectionKicker">FIND YOUR SOUND</span>
        </div>
        <h1>搜索音乐</h1>
        <p>一首惦记的歌，一位喜欢的歌手。找到你想听的那个版本。</p>
      </header>
      <SearchBox initialQuery={params.toString()} />
    </>
  );
}
