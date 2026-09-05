"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { refreshClientAccount } from "@/lib/accountClient";
import { ACCOUNT_CHANGE_EVENT } from "@/lib/accountEvents";

export function AccountSync() {
  const router = useRouter();
  useEffect(() => {
    let disposed=false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh=()=>{ if(!disposed && document.visibilityState!=="hidden") void refreshClientAccount().catch(()=>undefined); };
    const tick=async()=>{
      if(document.visibilityState!=="hidden") await refreshClientAccount().catch(()=>undefined);
      if(!disposed)timer=setTimeout(()=>void tick(),5000);
    };
    const changed=()=>{refresh();router.refresh();};
    void tick();
    window.addEventListener("focus",refresh);
    document.addEventListener("visibilitychange",refresh);
    window.addEventListener(ACCOUNT_CHANGE_EVENT,changed);
    return ()=>{disposed=true;clearTimeout(timer);window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",refresh);window.removeEventListener(ACCOUNT_CHANGE_EVENT,changed);};
  },[router]);
  return null;
}
