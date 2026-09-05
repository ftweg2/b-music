import { effectivePlaybackRange, type PlaybackRange } from "./playbackRange";

export type RangeAudio = Pick<HTMLAudioElement, "currentTime" | "duration" | "paused" | "playbackRate" | "pause" | "addEventListener" | "removeEventListener">;
/** Deadline timer supplements timeupdate, which can be too infrequent for a short cut. */
export function attachPlaybackBoundary(audio: RangeAudio, range: PlaybackRange, onStop: (invalid: boolean) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped=false;
  const clear=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
  const enforce=()=>{
    clear();
    if(!Number.isFinite(audio.duration)||audio.duration<=0)return;
    const bounds=effectivePlaybackRange(range,audio.duration);
    if(!bounds.valid){audio.pause();if(!stopped){stopped=true;onStop(true);}return;}
    if(audio.currentTime<bounds.start)audio.currentTime=bounds.start;
    if(bounds.stopAtEnd&&bounds.end!==null&&audio.currentTime>=bounds.end){
      audio.pause();audio.currentTime=bounds.end;
      if(!stopped){stopped=true;onStop(false);}return;
    }
    stopped=false;
    if(!audio.paused&&bounds.stopAtEnd&&bounds.end!==null){
      const milliseconds=(bounds.end-audio.currentTime)/Math.max(0.1,audio.playbackRate)*1000;
      timer=setTimeout(enforce,Math.max(10,Math.min(milliseconds,100)));
    }
  };
  const events=["play","playing","timeupdate","seeked","seeking","ratechange","durationchange","loadedmetadata"];
  for(const event of events)audio.addEventListener(event,enforce);
  audio.addEventListener("pause",clear);
  enforce();
  return ()=>{clear();for(const event of events)audio.removeEventListener(event,enforce);audio.removeEventListener("pause",clear);};
}

export function rangeMediaUrl(url: string, range: PlaybackRange | undefined): string {
  if(!range?.configured)return url;
  return url.split("#")[0]+"#t="+range.startSeconds+(range.endSeconds===null?"":","+range.endSeconds);
}
