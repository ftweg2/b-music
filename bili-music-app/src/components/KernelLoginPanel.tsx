"use client";

import { useEffect, useRef, useState } from "react";
import { accountChanged } from "@/lib/accountEvents";
import { ACCOUNT_STATUS_EVENT, publishClientAccount, refreshClientAccount, type ClientAccount } from "@/lib/accountClient";
import { requestLoginAction as post } from "@/lib/loginClient";

type LoginStatus = {
  loggedIn: boolean; biliUid?: string | null; nickname?: string | null; lastVerifiedAt?: string | null;
  loginStatus?: string; sessionKey?: string; libraryMode?: "local" | "account";
  appOwnerId?: string;
};

export function KernelLoginPanel() {
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const latest = useRef<LoginStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [qr, setQr] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [qrError, setQrError] = useState(false);
  const qrImage = useRef<HTMLImageElement>(null);

  function revealQr() {
    if (window.matchMedia("(max-width: 760px)").matches) qrImage.current?.scrollIntoView({ block: "center" });
  }
  useEffect(() => {
    if (!qr) return;
    const media = window.matchMedia("(max-width: 760px)");
    const frame = window.requestAnimationFrame(revealQr);
    media.addEventListener("change", revealQr);
    return () => { window.cancelAnimationFrame(frame); media.removeEventListener("change", revealQr); };
  }, [qr]);

  function publish(next: LoginStatus) {
    const previous = latest.current;
    latest.current = next; setStatus(next);
    if(next.appOwnerId&&next.sessionKey)publishClientAccount(next as ClientAccount);
    if (previous && (previous.loggedIn !== next.loggedIn || previous.biliUid !== next.biliUid || previous.sessionKey !== next.sessionKey)) accountChanged();
  }
  async function refresh(signal?: AbortSignal) {
    const response = await fetch("/api/kernel/login/status", {
      cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.loggedIn !== "boolean") throw new Error(data?.error || "暂时无法读取登录状态，请稍后重试。");
    if (signal?.aborted) return null;
    publish(data); return data as LoginStatus;
  }
  useEffect(()=>{
    const receive=(event:Event)=>{
      const next=(event as CustomEvent<LoginStatus>).detail;
      if(!next||typeof next.loggedIn!=="boolean")return;
      const changed=Boolean(latest.current?.sessionKey&&latest.current.sessionKey!==next.sessionKey);
      latest.current=next;setStatus(next);
      if(next.loggedIn||changed){setQr("");setSessionId("");}
    };
    window.addEventListener(ACCOUNT_STATUS_EVENT,receive);
    return()=>window.removeEventListener(ACCOUNT_STATUS_EVENT,receive);
  },[]);
  useEffect(() => {
    if (!sessionId) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [sessionId, expiresAt]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const finishQr = () => { setQr(""); setSessionId(""); };
    async function poll() {
      if (controller.signal.aborted) return;
      if (Date.now() >= expiresAt) { finishQr(); setMessage("二维码已过期，请重新扫码登录"); return; }
      try {
        const next = await refresh(controller.signal);
        if (!next || controller.signal.aborted) return;
        if (next.loggedIn) { finishQr(); setError(""); setMessage(next.libraryMode==="account"?"登录成功，已切换到此账号的音乐库和播放区间。":"登录成功，音乐库已保留。"); return; }
        if (next.loginStatus && next.loginStatus !== "pending") { finishQr(); setMessage("二维码已过期或本次连接已结束，请重新发起登录。"); return; }
        setError("");
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "登录状态查询失败"); }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [sessionId, expiresAt]);

  async function beginLogin() {
    const data = await post<{ loginSessionId: string; qrImageUrl: string; expiresInSeconds: number }>("/api/kernel/login/start", {});
    if (!data.loginSessionId || !data.qrImageUrl?.startsWith("/api/kernel/login/qr?") || !Number.isFinite(data.expiresInSeconds) || data.expiresInSeconds < 1) {
      throw new Error("二维码尚未准备好，请稍后重试。");
    }
    setExpiresAt(Date.now() + (data.expiresInSeconds || 180) * 1000);
    setQrError(false);
    setQr(data.qrImageUrl); setSessionId(data.loginSessionId);
    publish({ ...(latest.current || {}), loggedIn: false, loginStatus: "pending" });
    setMessage("请使用要登录的 Bilibili 账号扫码；成功后二维码会自动关闭。");
  }
  async function login() {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await beginLogin(); } catch (err) { setError(err instanceof Error ? err.message : "二维码创建失败"); }
    finally { setBusy(false); }
  }
  async function logout(switchAccount = false, cancelQr = false) {
    if (busy) return;
    const action = cancelQr ? "取消扫码" : switchAccount ? "更换 Bilibili 账号" : "退出 Bilibili 登录";
    if (!window.confirm(`${action}会清理这套共享服务的当前登录资料，需要重新扫码才能使用登录态搜索。收藏、关注和歌单不会删除。是否继续？`)) return;
    setBusy(true); setError(""); setMessage("");
    let cleared = false;
    try {
      await post("/api/kernel/login/logout", { confirmed: true });
      cleared = true; setQr(""); setSessionId(""); setExpiresAt(0);
      publish({ loggedIn: false, loginStatus: "logged_out", libraryMode: latest.current?.libraryMode });
      accountChanged();
      setMessage("已退出 Bilibili，原账号的收藏、关注、歌单和播放设置均已保留。");
      if (switchAccount) {
        const afterLogout=await refreshClientAccount();
        if(afterLogout.loggedIn)throw new Error("其他设备已登录了另一个账号，请刷新状态后重新确认换号。");
        await beginLogin();
      }
    } catch (err) {
      setError((cleared ? "旧账号已退出，但新二维码尚未创建。请点击扫码登录重试。 " : "") + (err instanceof Error ? err.message : "操作失败"));
    } finally { setBusy(false); }
  }
  async function check() {
    if (loading || busy) return;
    setLoading(true); setError("");
    try {
      const next = await refresh();
      setMessage(next?.loggedIn ? next.libraryMode==="account"?"已读取当前账号。连接同一服务的手机与网页共用此账号的设置。":"已读取当前登录状态。" : "当前未登录，可扫码登录或继续普通搜索。");
    } catch (err) { setError(err instanceof Error ? err.message : "状态检查失败"); }
    finally { setLoading(false); }
  }

  return <section className="kernelPanel">
    <div className="loginHeader"><div><h3 className="panelTitle">Bilibili 账号</h3><p className="note">{status?.libraryMode==="account"?"音乐库与播放区间按 B 站账号保存，网页和手机 API 共用；不会同步到 B 站收藏。":"B 站登录用于在线搜索与音频访问；音乐数据由本服务保存。"}</p></div>
      <span className={status?.loggedIn && !error ? "statusPill ok" : "statusPill"}>{loading ? "检查中" : error && !status ? "暂不可用" : sessionId ? "等待扫码" : status?.loggedIn ? `已登录：${status.nickname || status.biliUid || "Bilibili 用户"}` : "未登录"}</span>
    </div>
    <div className="row" style={{ marginTop: 18 }}>
      {status?.loggedIn ? <><button type="button" onClick={() => void logout(true)} disabled={busy || loading}>更换账号</button><button type="button" className="secondary" onClick={() => void logout()} disabled={busy || loading}>退出登录</button></> :
        sessionId ? <button type="button" className="secondary" onClick={() => void logout(false, true)} disabled={busy}>取消扫码</button> :
        <button type="button" onClick={() => void login()} disabled={busy || loading}>{busy ? "正在准备二维码…" : "扫码登录"}</button>}
      <button type="button" className="secondary" onClick={() => void check()} disabled={busy || loading}>刷新状态</button>
    </div>
    <p className="note loginLibraryNote">{status?.libraryMode === "account" ? "当前服务同一时刻使用一个 B 站登录。换号会切换此服务的当前音乐库，原账号数据不会删除，切回后可恢复。" : "换号不会清空本地音乐库。"}音频准备或搜索进行中时，请等任务完成后再换号。</p>
    {message && <p className="loginMessage" role="status">{message}</p>}
    {error && <p className="errorText" role="alert">{error}</p>}
    {qr && <div className="qrWrap"><img ref={qrImage} src={qr} alt="Bilibili 登录二维码" onError={() => setQrError(true)} onLoad={() => { setQrError(false); revealQr(); }} /><div><strong>使用要登录的账号扫码</strong><p className="note">请在手机上确认登录；剩余 {remaining} 秒。本次二维码不会在后台自动更换，过期后请重新获取。</p><p className="note">登录资料仅保存在内核中。</p>{qrError && <><p className="errorText" role="alert">二维码图片加载失败，可重新加载；不会创建新的扫码会话。</p><button type="button" className="secondary" onClick={() => { setQrError(false); setQr(value => value.replace(/&reload=\d+$/, "") + `&reload=${Date.now()}`); }}>重新加载二维码</button></>}</div></div>}
  </section>;
}
