import { PreferredCreatorList } from "@/components/PreferredCreatorList";

export default function CreatorsPage() {
  return (
    <>
      <header className="pageHeader">
        <h2>关注 UP</h2>
        <p>搜索结果里点“关注 UP”最省事；手动添加时粘一个 UP 主页链接或 mid 就够了。</p>
      </header>
      <PreferredCreatorList />
    </>
  );
}
