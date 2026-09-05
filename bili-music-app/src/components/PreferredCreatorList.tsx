"use client";
import { accountFetch } from "@/lib/accountClient";

import { useEffect, useState } from "react";
import { LIBRARY_CHANGE_EVENT, notifyLibraryChange } from "@/lib/libraryEvents";
import { ACCOUNT_CHANGE_EVENT } from "@/lib/accountEvents";
import type { PreferredCreator } from "@/lib/models";
import { PreferredCreatorForm } from "./PreferredCreatorForm";
import { UserCheckIcon, UsersIcon, ExternalLinkIcon, TrashIcon } from "./Icons";

export function PreferredCreatorList() {
  const [creators, setCreators] = useState<PreferredCreator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadCreators() {
    setLoading(true);
    setError("");
    try {
      const response = await accountFetch("/api/creators");
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload.error || "加载关注 UP 失败"));
      }
      setCreators(payload.creators || []);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCreators();
    const changed=()=>{setCreators([]);void loadCreators();};
    const library=()=>void loadCreators();
    window.addEventListener(ACCOUNT_CHANGE_EVENT,changed);window.addEventListener(LIBRARY_CHANGE_EVENT,library);
    return()=>{window.removeEventListener(ACCOUNT_CHANGE_EVENT,changed);window.removeEventListener(LIBRARY_CHANGE_EVENT,library);};
  }, []);

  async function removeCreator(id: number, name: string) {
    if (!window.confirm(`确定取消关注「${name}」吗？`)) {
      return;
    }
    try {
      const response = await accountFetch(`/api/creators/${id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload.error || "删除失败"));
      }
      const removed = creators.find((creator) => creator.id === id);
      if (removed) notifyLibraryChange({ kind: "creator", biliMid: removed.biliMid, followed: false });
      setCreators((prev) => prev.filter((creator) => creator.id !== id));
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="pageNarrow pageNarrowWide">
      <PreferredCreatorForm onCreated={() => void loadCreators()} />

      <section className="card creatorListCard">
        <div className="cardToolbar">
          <div className="cardToolbarTitle">
            <UsersIcon size={18} />
            <div>
              <span className="sectionKicker">YOUR CREATORS</span>
              <h3>已关注的音乐 UP 主</h3>
            </div>
            <span className="badge">{creators.length} 位</span>
          </div>

          <button
            type="button"
            className="secondary"
            onClick={() => void loadCreators()}
          >
            刷新
          </button>
        </div>

        {error ? (
          <div className="errorText listMessage">{error}</div>
        ) : loading ? (
          <div className="listMessage">
            正在拉取关注 UP 主列表...
          </div>
        ) : creators.length === 0 ? (
          <div className="empty">
            <UserCheckIcon size={32} style={{ opacity: 0.35 }} />
            <strong>还没有关注的 UP 主</strong>
            <span>可以从搜索结果快速关注，也可以在上方手动添加</span>
          </div>
        ) : (
          <div className="tableWrapper">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: "35%" }}>UP 主</th>
                  <th style={{ width: "25%" }}>UID / MID</th>
                  <th style={{ width: "20%" }}>作品</th>
                  <th style={{ width: "20%", textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {creators.map((creator) => (
                  <tr key={creator.id}>
                    <td>
                      <div className="creatorIdentity">
                        <div className="creatorAvatar">
                          {creator.name.slice(0, 1).toUpperCase()}
                        </div>
                        <div>
                          <div className="creatorName">
                            {creator.name}
                          </div>
                          {creator.notes && (
                            <small className="creatorNotes">
                              {creator.notes}
                            </small>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <code className="creatorMid">
                        {creator.biliMid}
                      </code>
                    </td>
                    <td>
                      <a className="textLink" href={`/search?q=${encodeURIComponent(creator.name)}`}>搜索作品 ↗</a>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div className="tableActions">
                        <a
                          className="buttonLink secondary"
                          href={creator.homepageUrl || `https://space.bilibili.com/${creator.biliMid}`}
                          target="_blank"
                          rel="noreferrer"
                          title="访问 Bilibili 个人空间"
                        >
                          <ExternalLinkIcon size={12} />
                          空间
                        </a>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => void removeCreator(creator.id, creator.name)}
                          title="取消关注"
                        >
                          <TrashIcon size={12} />
                          取消
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
