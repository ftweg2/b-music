"use client";

import { useEffect, useState } from "react";

import type { PreferredCreator } from "@/lib/models";
import { PreferredCreatorForm } from "./PreferredCreatorForm";

export function PreferredCreatorList() {
  const [creators, setCreators] = useState<PreferredCreator[]>([]);
  const [message, setMessage] = useState("");

  async function load() {
    const response = await fetch("/api/creators", { cache: "no-store" });
    const payload = await response.json();
    setCreators(payload.creators || []);
  }

  async function remove(id: number) {
    const response = await fetch(`/api/creators/${id}`, { method: "DELETE" });
    setMessage(response.ok ? "已删除" : "删除失败");
    await load();
  }

  async function updateWeight(creator: PreferredCreator, priorityWeight: number) {
    const response = await fetch(`/api/creators/${creator.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priorityWeight })
    });
    setMessage(response.ok ? "权重已更新" : "更新失败");
    await load();
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PreferredCreatorForm onCreated={load} />
      <section className="panel">
        <div className="row">
          <h3 className="panelTitle">已关注 UP</h3>
          <span className="note">{message}</span>
        </div>
        {creators.length ? (
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>昵称</th>
                  <th>关注强度</th>
                  <th>主页</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {creators.map((creator) => (
                  <tr key={creator.id}>
                    <td>
                      <strong>{creator.name}</strong>
                      <div className="note">mid {creator.biliMid}</div>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        defaultValue={creator.priorityWeight}
                        onBlur={(event) => updateWeight(creator, Number(event.target.value))}
                      />
                    </td>
                    <td>
                      {creator.homepageUrl ? (
                        <a href={creator.homepageUrl} target="_blank" rel="noreferrer">
                          打开
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>
                      <button type="button" className="danger" onClick={() => remove(creator.id)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">还没有关注 UP。可以在搜索结果卡片里点“关注 UP”，也可以手动添加。</div>
        )}
      </section>
    </>
  );
}
