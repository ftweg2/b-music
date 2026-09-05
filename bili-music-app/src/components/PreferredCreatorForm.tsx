"use client";
import { accountFetch } from "@/lib/accountClient";

import { useState, type FormEvent } from "react";
import { UserPlusIcon, SparklesIcon } from "./Icons";

export function PreferredCreatorForm({ onCreated }: { onCreated?: () => void }) {
  const [midOrUrl, setMidOrUrl] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = midOrUrl.trim();
    if (!target) {
      setMessage("请填写 UP 主的 UID 或主页链接");
      setSuccess(false);
      return;
    }
    setLoading(true);
    setMessage("");
    setSuccess(false);
    try {
      const response = await accountFetch("/api/creators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          biliMid: /^\d+$/.test(target) ? target : undefined,
          homepageUrl: /^\d+$/.test(target) ? undefined : target,
          name: name.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload.error || "添加失败"));
      }
      setSuccess(true);
      setMessage(`已成功关注 UP 主：${payload.creator?.name || target}`);
      setMidOrUrl("");
      setName("");
      onCreated?.();
    } catch (error) {
      setSuccess(false);
      setMessage(String(error instanceof Error ? error.message : error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card creatorFormCard">
      <div className="cardSectionHeader">
        <div className="sectionIcon">
          <UserPlusIcon size={18} />
        </div>
        <div>
          <span className="sectionKicker">ADD CREATOR</span>
          <h3>添加关注</h3>
          <p>输入 UID 或 Bilibili 个人空间地址，把喜欢的创作者保存在这里。</p>
        </div>
      </div>

      <form className="creatorForm" onSubmit={submit}>
        <div className="creatorFormFields">
          <input
            value={midOrUrl}
            onChange={(event) => setMidOrUrl(event.target.value)}
            placeholder="UP 主 UID 或个人空间 URL"
            aria-label="UP 主 UID 或个人空间 URL"
            required
          />
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="备注名称（可选）"
            aria-label="备注名称"
          />
          <button
            className="button creatorSubmit"
            type="submit"
            disabled={loading}
          >
            {loading ? (
              <span>解析添加中...</span>
            ) : (
              <>
                <SparklesIcon size={16} />
                <span>关注 UP</span>
              </>
            )}
          </button>
        </div>

        {message && (
          <div className={`formFeedback ${success ? "success" : ""}`} role="status">
            <span className={`badge ${success ? "success" : "primary"}`}>
              {success ? "成功" : "提示"}
            </span>
            <span>{message}</span>
          </div>
        )}
      </form>
    </section>
  );
}
