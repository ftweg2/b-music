"use client";

import { useState } from "react";

export function PreferredCreatorForm({ onCreated }: { onCreated?: () => void }) {
  const [creatorInput, setCreatorInput] = useState("");
  const [priorityWeight, setPriorityWeight] = useState(70);
  const [message, setMessage] = useState("");

  async function submit() {
    const cleanInput = creatorInput.trim();
    if (!cleanInput) {
      setMessage("粘贴 UP 主页链接，或者输入 mid 就能关注。");
      return;
    }
    const mid = extractMid(cleanInput);
    const response = await fetch("/api/creators", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        biliMid: mid || cleanInput,
        name: mid ? `UP ${mid}` : "",
        homepageUrl: mid ? `https://space.bilibili.com/${mid}` : cleanInput,
        priorityWeight
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "保存失败");
      return;
    }
    setMessage("已关注 UP");
    setCreatorInput("");
    setPriorityWeight(70);
    onCreated?.();
  }

  return (
    <section className="panel">
      <h3 className="panelTitle">关注一个音乐 UP</h3>
      <div className="creatorQuickForm">
        <label>
          UP 主页链接或 mid
          <input
            value={creatorInput}
            onChange={(event) => setCreatorInput(event.target.value)}
            placeholder="粘贴 https://space.bilibili.com/37069954 或直接输入 37069954"
          />
        </label>
        <label>
          关注强度
          <input
            type="number"
            min={0}
            max={100}
            value={priorityWeight}
            onChange={(event) => setPriorityWeight(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={submit}>关注 UP</button>
        <span className="note">更推荐在搜索结果里点“关注 UP”，会自动带上昵称。</span>
        <span className="note">{message}</span>
      </div>
    </section>
  );
}

function extractMid(value: string): string | null {
  const match = value.match(/(?:space\.bilibili\.com\/)?(\d{1,24})/);
  return match ? match[1] : null;
}
