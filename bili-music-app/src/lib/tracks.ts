import {
  claimTrackPreparation,
  createOrReuseTrack,
  getCandidateByBvid,
  getCandidateById,
  getOrHydrateFavoriteCandidateByBvid,
  getTrackByCandidateId,
  getTrackById,
  updateTrack
} from "./db";
import {
  getKernelJob,
  KernelRequestError,
  listKernelArtifacts,
  submitKernelAudioJob,
  type KernelArtifact,
  type KernelJobStatus
} from "./kernelClient";
import type { Track } from "./models";
import { sanitizeBvid, sanitizeText } from "./sanitize";

type StrategyName = "api_dash" | "browser_network" | "mse_sourcebuffer";
type StrategyMode = "auto" | "force";

export type PrepareTrackInput = {
  candidateId?: number;
  bvid?: string;
  profileId: string;
  appOwnerId?: string;
  externalOwnerId?: string;
  strategyMode?: StrategyMode;
  strategy?: StrategyName;
  strategyOrder?: StrategyName[];
  forceRefresh?: boolean;
};

const TERMINAL_FAILED = new Set(["failed", "cancelled"]);
const syncingTracks = new Map<string, Promise<Track>>();

type ReusableTrackInput = Pick<
  PrepareTrackInput,
  "candidateId" | "bvid" | "appOwnerId" | "externalOwnerId" | "strategyMode" | "strategy"
>;

export function getReusablePreparedTrack(input: ReusableTrackInput): Track | null {
  const strategyMode = normalizeStrategyMode(input.strategyMode);
  if (strategyMode === "force" && !input.strategy) {
    throw new Error("强制策略模式需要指定 strategy");
  }
  const candidate = resolvePlayableCandidate(input);
  if (!candidate) {
    throw new Error("候选视频不存在");
  }
  const appOwnerId = sanitizeText(input.appOwnerId || "local", 128) || "local";
  const existing = getTrackByCandidateId(candidate.id, appOwnerId);
  if (!existing) {
    return null;
  }
  const track = expireIfNeeded(existing);
  if (track.status === "ready" || (track.status === "preparing" && track.kernelJobId)) {
    return track;
  }
  return null;
}

export async function prepareTrack(input: PrepareTrackInput): Promise<Track> {
  const candidate = resolvePlayableCandidate(input);
  if (!candidate) {
    throw new Error("候选视频不存在");
  }
  const profileId = sanitizeRequired(input.profileId, "请先填写 kernel profile_id");
  const externalOwnerId = sanitizeText(
    input.externalOwnerId || process.env.KERNEL_EXTERNAL_OWNER_ID || process.env.APP_OWNER_ID || "local",
    128
  );
  const appOwnerId = sanitizeText(input.appOwnerId || "local", 128) || "local";
  const strategyMode = normalizeStrategyMode(input.strategyMode);
  if (strategyMode === "force" && !input.strategy) {
    throw new Error("强制策略模式需要指定 strategy");
  }

  let track = createOrReuseTrack(candidate, appOwnerId);
  track = expireIfNeeded(track);
  if (!input.forceRefresh && track.status === "ready") {
    return track;
  }
  if (track.status === "preparing" && track.kernelJobId) {
    return track;
  }

  const jobId = newKernelJobId(track.id);
  const claimed = claimTrackPreparation(track.id, jobId, appOwnerId, externalOwnerId);
  if (!claimed) {
    return getTrackById(track.id, appOwnerId) || track;
  }
  track = claimed;
  try {
    await submitKernelAudioJob({
      jobId,
      externalOwnerId,
      profileId,
      url: candidate.sourceUrl,
      strategyMode,
      strategy: input.strategy,
      strategyOrder: input.strategyOrder
    });
    return track;
  } catch (error) {
    const definitiveRejection = error instanceof KernelRequestError && (!error.retryable || error.submissionRejected);
    return updateTrack(track.id, {
      status: definitiveRejection ? "failed" : "preparing",
      failureReason: sanitizeText(
        definitiveRejection
          ? `内核拒绝了任务：${sanitizeText(error)}`
          : `内核任务提交状态待确认：${sanitizeText(error)}`
      ),
      expiresAt: null
    }, appOwnerId);
  }
}

export async function refreshTrack(
  trackId: number,
  input: Omit<PrepareTrackInput, "candidateId" | "forceRefresh">
): Promise<Track> {
  const appOwnerId = sanitizeText(input.appOwnerId || "local", 128) || "local";
  const track = getTrackById(trackId, appOwnerId);
  if (!track) {
    throw new Error("Track 不存在");
  }
  return prepareTrack({
    ...input,
    appOwnerId,
    candidateId: track.candidateId,
    forceRefresh: true
  });
}

function resolvePlayableCandidate(
  input: Pick<PrepareTrackInput, "candidateId" | "bvid" | "appOwnerId" | "externalOwnerId">
) {
  if (Number.isFinite(input.candidateId)) {
    const candidate = getCandidateById(Number(input.candidateId));
    if (candidate) {
      return candidate;
    }
  }
  const bvid = sanitizeBvid(input.bvid);
  if (!bvid) {
    return null;
  }
  const externalOwnerId = sanitizeText(
    input.externalOwnerId || process.env.KERNEL_EXTERNAL_OWNER_ID || process.env.APP_OWNER_ID || "local",
    128
  );
  const appOwnerId = sanitizeText(input.appOwnerId || externalOwnerId, 128);
  return (
    getCandidateByBvid(bvid) ||
    getOrHydrateFavoriteCandidateByBvid(bvid, appOwnerId)
  );
}

export async function getSyncedTrack(trackId: number, appOwnerId = "local"): Promise<Track | null> {
  const track = getTrackById(trackId, appOwnerId);
  if (!track) {
    return null;
  }
  const fresh = expireIfNeeded(track);
  if (fresh.status === "preparing" && fresh.kernelJobId) {
    const key = `${appOwnerId}:${trackId}`;
    const running = syncingTracks.get(key);
    if (running) return running;
    const pending = syncTrackWithKernel(fresh).finally(() => syncingTracks.delete(key));
    syncingTracks.set(key, pending);
    return pending;
  }
  return fresh;
}

export async function syncTrackWithKernel(track: Track): Promise<Track> {
  if (!track.kernelJobId) {
    return updateTrack(track.id, { status: "pending", failureReason: null }, track.externalOwnerId);
  }
  try {
    const job = await getKernelJob(track.kernelJobId, track.kernelOwnerId);
    if (job.status === "succeeded") {
      return await syncSucceededJob(track, job);
    }
    if (TERMINAL_FAILED.has(job.status)) {
      return updateTrack(track.id, {
        status: "failed",
        failureReason: sanitizeText(job.sanitized_error || `kernel job ${job.status}`),
        expiresAt: null
      }, track.externalOwnerId);
    }
    return updateTrack(track.id, {
      status: "preparing",
      failureReason: null
    }, track.externalOwnerId);
  } catch (error) {
    if (error instanceof KernelRequestError && !error.retryable) {
      return updateTrack(track.id, {
        status: "failed",
        failureReason: sanitizeText(
          error.status === 404
            ? "内核任务不存在，请重新准备"
            : `内核任务无法继续：${error.message}`
        ),
        expiresAt: null
      }, track.externalOwnerId);
    }
    return updateTrack(track.id, {
      status: "preparing",
      failureReason: sanitizeText(`暂时无法连接内核，将继续重试：${sanitizeText(error)}`)
    }, track.externalOwnerId);
  }
}

export function selectPlayableArtifact(artifacts: KernelArtifact[]): KernelArtifact | null {
  return (
    artifacts.find((artifact) => artifact.name === "audio.m4a") ||
    artifacts.find((artifact) => artifact.type === "m4a") ||
    artifacts.find((artifact) => (artifact.mime_guess || "").toLowerCase().startsWith("audio/")) ||
    null
  );
}

export function isTrackExpired(track: Track): boolean {
  return Boolean(track.expiresAt && Date.parse(track.expiresAt) <= Date.now());
}

function expireIfNeeded(track: Track): Track {
  if (track.status === "ready" && isTrackExpired(track)) {
    return updateTrack(
      track.id,
      { status: "expired", failureReason: "音频缓存已过期" },
      track.externalOwnerId
    );
  }
  return track;
}

async function syncSucceededJob(track: Track, job: KernelJobStatus): Promise<Track> {
  const artifactList = await listKernelArtifacts(job.job_id, track.kernelOwnerId);
  const artifact = selectPlayableArtifact(artifactList.artifacts);
  if (!artifact) {
    return updateTrack(track.id, {
      status: "failed",
      failureReason: "kernel job succeeded but audio.m4a artifact was not found",
      expiresAt: null
    }, track.externalOwnerId);
  }
  return updateTrack(track.id, {
    kernelJobId: job.job_id,
    artifactName: artifact.name,
    artifactSha256: artifact.sha256,
    artifactSizeBytes: artifact.size_bytes,
    artifactMimeType: artifact.mime_guess || "audio/mp4",
    status: "ready",
    failureReason: null,
    expiresAt: expiresAtIso()
  }, track.externalOwnerId);
}

export async function getSyncedTracks(
  trackIds: number[],
  appOwnerId = "local",
  concurrency = 4
): Promise<Array<Track | null>> {
  const results = new Array<Track | null>(trackIds.length);
  let cursor = 0;
  async function worker() {
    while (cursor < trackIds.length) {
      const index = cursor++;
      results[index] = await getSyncedTrack(trackIds[index], appOwnerId);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), trackIds.length) }, worker)
  );
  return results;
}

function newKernelJobId(trackId: number): string {
  return `app_track_${trackId}_${Date.now()}`;
}

function expiresAtIso(): string {
  const configured = Number(process.env.TRACK_ARTIFACT_TTL_SECONDS || 24 * 60 * 60);
  const ttlSeconds = Number.isFinite(configured) ? Math.max(300, configured) : 24 * 60 * 60;
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function normalizeStrategyMode(value: unknown): StrategyMode {
  return value === "force" ? "force" : "auto";
}

function sanitizeRequired(value: unknown, message: string): string {
  const text = sanitizeText(value, 128);
  if (!text) {
    throw new Error(message);
  }
  return text;
}
