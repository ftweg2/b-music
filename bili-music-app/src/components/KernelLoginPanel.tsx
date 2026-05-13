"use client";

import { useEffect, useState } from "react";

type LoginStatus = {
  loggedIn: boolean;
  biliUid?: string | null;
  nickname?: string | null;
  lastVerifiedAt?: string | null;
};

export function KernelLoginPanel() {
  const [message, setMessage] = useState("");
  const [qrImageUrl, setQrImageUrl] = useState("");
  const [loginSessionId, setLoginSessionId] = useState("");
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshStatus(false);
  }, []);

  useEffect(() => {
    if (!loginSessionId) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshStatus(false);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [loginSessionId]);

  async function startLogin() {
    await runAction(async () => {
      const payload = await postJson<{
        loginSessionId: string;
        qrImageUrl: string;
        expiresInSeconds?: number;
      }>("/api/kernel/login/start", {});
      setLoginSessionId(payload.loginSessionId);
      setQrImageUrl(`${payload.qrImageUrl}&t=${Date.now()}`);
      setMessage(`请用 Bilibili 手机端扫码，二维码约 ${payload.expiresInSeconds || 180} 秒内有效`);
      await refreshStatus(false);
    });
  }

  async function refreshStatus(showMessage = true) {
    try {
      const response = await fetch("/api/kernel/login/status", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "登录状态查询失败");
      }
      setLoginStatus(payload);
      if (showMessage) {
        setMessage(payload.loggedIn ? "已登录，收藏和关注会保存在这个账号下" : "还未登录，扫码后自动刷新");
      }
    } catch (error) {
      if (showMessage) {
        setMessage(String(error instanceof Error ? error.message : error));
      }
    }
  }

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="kernelPanel">
      <div className="loginHeader">
        <div>
          <h3 className="panelTitle">Bilibili 登录</h3>
          <p className="note">扫码后即可使用登录态搜索和播放；Cookie 只保存在本机内核 profile 中。</p>
        </div>
        <div className={loginStatus?.loggedIn ? "statusPill ok" : "statusPill"}>
          {loginStatus?.loggedIn ? `已登录：${loginStatus.nickname || loginStatus.biliUid || "Bilibili 用户"}` : "未登录"}
        </div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={startLogin} disabled={busy}>
          扫码登录
        </button>
        <button type="button" className="secondary" onClick={() => refreshStatus(true)} disabled={busy}>
          刷新状态
        </button>
        <span className="note">{message}</span>
      </div>

      {qrImageUrl ? (
        <div className="qrWrap">
          <img src={qrImageUrl} alt="Bilibili 登录二维码" />
          <div>
            <strong>用 Bilibili 手机端扫码</strong>
            <p className="note">扫码完成后这里会自动刷新。页面不会看到 Cookie、storage_state 或二维码 token。</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

async function postJson<T>(url: string, body: object): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload as T;
}
