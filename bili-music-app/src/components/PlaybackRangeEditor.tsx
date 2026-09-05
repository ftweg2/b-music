"use client";
import { useEffect, useRef, useState } from "react";
import { accountFetch } from "@/lib/accountClient";
import { formatPlaybackTime, parsePlaybackTime, type PlaybackRange } from "@/lib/playbackRange";

export function PlaybackRangeEditor({range,duration,currentTime,onSaved,onClose}: {
  range:PlaybackRange;duration:number;currentTime:number;onSaved:(range:PlaybackRange)=>void;onClose:()=>void;
}) {
  const [start,setStart]=useState(formatPlaybackTime(range.startSeconds));
  const [end,setEnd]=useState(range.endSeconds===null?"":formatPlaybackTime(range.endSeconds));
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState("");
  const [base,setBase]=useState(range);
  const lifetime=useRef<AbortController | null>(null);
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>controller.abort();},[]);
  useEffect(()=>{
    if(range.accountId!==base.accountId||range.bvid!==base.bvid)onClose();
    else if(range.revision!==base.revision)setMessage("其他设备更新了区间。先重新读取，避免覆盖新设置。");
  },[range,base,onClose]);
  async function reload() {
    setSaving(true);setMessage("");
    try {
      const response=await accountFetch("/api/playback-ranges/"+range.bvid,{cache:"no-store",signal:lifetime.current?.signal});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"读取失败");
      const next=data.playbackRange as PlaybackRange;
      lifetime.current?.signal.throwIfAborted();
      setBase(next);setStart(formatPlaybackTime(next.startSeconds));setEnd(next.endSeconds===null?"":formatPlaybackTime(next.endSeconds));onSaved(next);
    } catch(error){setMessage(error instanceof Error?error.message:"读取失败");}
    finally{setSaving(false);}
  }
  async function save(reset=false) {
    const startSeconds=reset?0:parsePlaybackTime(start);
    const endSeconds=reset?null:parsePlaybackTime(end);
    if(startSeconds===null||!Number.isFinite(startSeconds)||(endSeconds!==null&&!Number.isFinite(endSeconds))) {setMessage("请输入秒数或 分:秒，例如 0:12.5；结束时间可留空。");return;}
    if(startSeconds<0||(endSeconds!==null&&endSeconds<=startSeconds)||(duration>0&&(startSeconds>=duration||(endSeconds!==null&&endSeconds>duration)))) {setMessage("开始需早于结束，且不能超出歌曲时长。");return;}
    setSaving(true);setMessage("");
    try {
      const response=await accountFetch("/api/playback-ranges/"+range.bvid,{method:"PATCH",signal:lifetime.current?.signal,headers:{"content-type":"application/json"},body:JSON.stringify({startSeconds,endSeconds,expectedRevision:base.revision,expectedAccountId:base.accountId})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"保存失败");
      lifetime.current?.signal.throwIfAborted();
      onSaved(data.playbackRange);onClose();
    } catch(error){setMessage(error instanceof Error?error.message:"保存失败");}
    finally{setSaving(false);}
  }
  return <section className="playbackRangePanel" role="dialog" aria-label="设置播放区间">
    <header><div><strong>播放区间</strong><p>网页与手机共用当前账号的设置</p></div><button type="button" className="iconBtn ghost" onClick={onClose} disabled={saving} aria-label="关闭播放区间">×</button></header>
    <div className="playbackRangeFields">
      <label><span>从哪里开始</span><input autoFocus aria-label="播放开始时间" value={start} placeholder="0:00" onChange={event=>setStart(event.target.value)} disabled={saving}/><button type="button" className="textLink" onClick={()=>setStart(formatPlaybackTime(currentTime))} disabled={saving}>设为当前进度</button></label>
      <label><span>到哪里停止</span><input aria-label="播放结束时间" value={end} placeholder="留空播放到结尾" onChange={event=>setEnd(event.target.value)} disabled={saving}/><button type="button" className="textLink" onClick={()=>setEnd(formatPlaybackTime(currentTime))} disabled={saving}>设为当前进度</button></label>
    </div>
    <p className="note">支持秒数、分:秒和小数。{duration>0?`原曲 ${formatPlaybackTime(duration)}。`:""}指定终点后停止，不自动切歌；原音频不会被修改。</p>
    {message&&<p role="alert" className="errorText">{message}</p>}
    <footer><button type="button" className="textLink" onClick={()=>void save(true)} disabled={saving}>恢复整首</button><button type="button" className="secondary" onClick={()=>void reload()} disabled={saving}>重新读取</button><button type="button" onClick={()=>void save()} disabled={saving}>{saving?"保存中…":"保存区间"}</button></footer>
  </section>;
}
