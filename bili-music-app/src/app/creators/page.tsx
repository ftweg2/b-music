import { PreferredCreatorList } from "@/components/PreferredCreatorList";
import { UsersIcon } from "@/components/Icons";

export default function CreatorsPage() {
  return (
    <>
      <header className="pageHeader">
        <div className="pageTitleRow">
          <div className="pageIcon mint">
            <UsersIcon size={20} />
          </div>
          <span className="sectionKicker">PREFERRED CREATORS</span>
        </div>
        <h1>关注 UP 主</h1>
        <p>保存喜欢的音乐创作者，随时访问他们的主页或搜索作品。</p>
      </header>
      <PreferredCreatorList />
    </>
  );
}
