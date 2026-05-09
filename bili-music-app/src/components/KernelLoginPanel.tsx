"use client";

import { useEffect, useState } from "react";

type KernelLoginPanelProps = {
  externalOwnerId: string;
  profileId: string;
  onExternalOwnerIdChange: (value: string) => void;
  onProfileIdChange: (value: string) => void;
};

type LoginStatus = {
  profileId: string;
  loggedIn: boolean;
  biliUid?: string | null;
  nickname?: string | null;
  appOwnerId?: string;
  lastVerifiedAt?: string | null;
};

export function KernelLoginPanel({
  externalOwnerId,
  profileId,
  onExternalOwnerIdChange,
  onProfileIdChange
}: KernelLoginPanelProps) {
  const [message, setMessage] = useState("");
  const [qrImageUrl, setQrImageUrl] = useState("");
  const [loginSessionId, setLoginSessionId] = useState("");
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const savedOwnerId = window.localStorage.getItem("kernel_external_owner_id");
    const savedProfileId = window.localStorage.getItem("kernel_profile_id");
    if (savedOwnerId && !externalOwnerId) {
      onExternalOwnerIdChange(savedOwnerId);
    }
    if (savedProfileId && !profileId) {
      onProfileIdChange(savedProfileId);
    }
  }, []);

  useEffect(() => {
    if (externalOwnerId) {
      window.localStorage.setItem("kernel_external_owner_id", externalOwnerId);
    }
  }, [externalOwnerId]);

  useEffect(() => {
    if (profileId) {
      window.localStorage.setItem("kernel_profile_id", profileId);
    }
  }, [profileId]);

  useEffect(() => {
    if (!loginSessionId || !profileId || !externalOwnerId) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshStatus(false);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [loginSessionId, profileId, externalOwnerId]);

  async function createProfile() {
    await runAction(async () => {
      const payload = await postJson<{ profileId: string; externalOwnerId: string; status: string }>("/api/kernel/profiles", {
        externalOwnerId
      });
      onExternalOwnerIdChange(payload.externalOwnerId);
      onProfileIdChange(payload.profileId);
      setMessage(payload.status === "created" ? "已创建 kernel profile" : "已绑定已有 kernel profile");
      setLoginStatus(null);
      setQrImageUrl("");
    });
  }

  async function startLogin() {
    await runAction(async () => {
      const payload = await postJson<{
        loginSessionId: string;
        qrImageUrl: string;
        expiresInSeconds?: number;
      }>("/api/kernel/login/start", {
        externalOwnerId,
        profileId
      });
      setLoginSessionId(payload.loginSessionId);
      setQrImageUrl(`${payload.qrImageUrl}&t=${Date.now()}`);
      setMessage(`扫码登录已启动，二维码约 ${payload.expiresInSeconds || 180} 秒内有效`);
      await refreshStatus(false);
    });
  }

  async function refreshStatus(showMessage = true) {
    if (!profileId || !externalOwnerId) {
      if (showMessage) {
        setMessage("请先创建或填写 kernel profile");
      }
      return;
    }
    try {
      const response = await fetch(
        `/api/kernel/login/status?profileId=${encodeURIComponent(profileId)}&externalOwnerId=${encodeURIComponent(externalOwnerId)}`,
        { cache: "no-store" }
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "登录状态查询失败");
      }
      setLoginStatus(payload);
      if (payload.loggedIn && payload.appOwnerId) {
        window.localStorage.setItem("bili_music_app_owner_id", payload.appOwnerId);
        if (payload.nickname) {
          window.localStorage.setItem("bili_music_app_owner_name", payload.nickname);
        }
      }
      if (showMessage) {
        setMessage(payload.loggedIn ? "已登录，可以使用内核登录态搜索" : "当前 profile 还未登录");
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
      <div>
        <h3 className="panelTitle">内核登录态</h3>
        <p className="note">扫码和 Cookie 都只进入 kernel profile。App 只显示二维码和脱敏登录状态。</p>
      </div>

      <div className="grid">
        <label>
          外部用户/团队 ID
          <input value={externalOwnerId} onChange={(event) => onExternalOwnerIdChange(event.target.value)} />
        </label>
        <label>
          Kernel profile_id
          <input value={profileId} onChange={(event) => onProfileIdChange(event.target.value)} placeholder="p_xxx" />
        </label>
        <label>
          登录状态
          <div className={loginStatus?.loggedIn ? "statusPill ok" : "statusPill"}>
            {loginStatus?.loggedIn ? `已登录：${loginStatus.nickname || loginStatus.biliUid || "Bilibili 用户"}` : "未确认登录"}
          </div>
          {loginStatus?.appOwnerId ? <small className="note">收藏身份：{loginStatus.appOwnerId}</small> : null}
        </label>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="secondary" onClick={createProfile} disabled={busy || !externalOwnerId}>
          创建/绑定 Profile
        </button>
        <button type="button" onClick={startLogin} disabled={busy || !externalOwnerId || !profileId}>
          启动扫码登录
        </button>
        <button type="button" className="ghost" onClick={() => refreshStatus(true)} disabled={busy || !externalOwnerId || !profileId}>
          刷新登录状态
        </button>
        <span className="note">{message}</span>
      </div>

      {qrImageUrl ? (
        <div className="qrWrap">
          <img src={qrImageUrl} alt="Bilibili 登录二维码" />
          <div>
            <strong>用 Bilibili 手机端扫码</strong>
            <p className="note">
              扫码完成后点“刷新登录状态”。二维码只是截图代理，不包含 Cookie、storage_state 或二维码 token。
            </p>
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
