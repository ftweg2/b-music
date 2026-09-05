export type KernelHealth = {
  status: string;
};

export type KernelJobStatus = {
  job_id: string;
  status: "queued" | "validating_profile" | "preparing_context" | "running_api_dash" | "running_browser_network" | "running_mse_sourcebuffer" | "processing_media" | "succeeded" | "failed" | "cancelled" | string;
  stage: string;
  selected_strategy: string | null;
  sanitized_error: string | null;
};

export type KernelArtifact = {
  name: string;
  type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  producer_strategy: string;
  mime_guess: string | null;
};

export type KernelArtifactList = {
  job_id: string;
  artifacts: KernelArtifact[];
};

export class KernelRequestError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean, public readonly submissionRejected = false, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "KernelRequestError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function kernelBaseUrl(): string {
  return (process.env.KERNEL_BASE_URL || "http://localhost:8000").replace(/\/+$/, "");
}

export async function getKernelHealth(): Promise<KernelHealth> {
  const response = await fetch(`${kernelBaseUrl()}/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(kernelRequestTimeoutMs(5_000))
  });
  if (!response.ok) {
    throw new Error(`内核健康检查失败：HTTP ${response.status}`);
  }
  return response.json() as Promise<KernelHealth>;
}

export async function submitKernelAudioJob(input: {
  jobId: string;
  externalOwnerId: string;
  profileId: string;
  url: string;
  strategyMode: "auto" | "force";
  strategy?: "api_dash" | "browser_network" | "mse_sourcebuffer";
  strategyOrder?: Array<"api_dash" | "browser_network" | "mse_sourcebuffer">;
}): Promise<{ job_id: string; status: string; stage: string }> {
  return readKernelJson("/v1/jobs", {
    method: "POST",
    body: JSON.stringify({
      job_id: input.jobId,
      external_owner_id: input.externalOwnerId,
      profile_id: input.profileId,
      url: input.url,
      strategy_mode: input.strategyMode,
      strategy: input.strategyMode === "force" ? input.strategy : undefined,
      strategy_order: input.strategyMode === "auto" ? input.strategyOrder : undefined,
      outputs: ["m4a"]
    })
  });
}

export async function getKernelJob(jobId: string, externalOwnerId: string): Promise<KernelJobStatus> {
  return readKernelJson<KernelJobStatus>(
    `/v1/jobs/${encodeURIComponent(jobId)}?external_owner_id=${encodeURIComponent(externalOwnerId)}`
  );
}

export async function listKernelArtifacts(jobId: string, externalOwnerId: string): Promise<KernelArtifactList> {
  return readKernelJson<KernelArtifactList>(
    `/v1/jobs/${encodeURIComponent(jobId)}/artifacts?external_owner_id=${encodeURIComponent(externalOwnerId)}`
  );
}

export function kernelArtifactUrl(jobId: string, artifactName: string, externalOwnerId: string): string {
  return `${kernelBaseUrl()}/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactName)}?external_owner_id=${encodeURIComponent(externalOwnerId)}`;
}

export async function readKernelJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${kernelBaseUrl()}${path}`, {
      ...init,
      cache: "no-store",
      signal: init?.signal || AbortSignal.timeout(kernelRequestTimeoutMs()),
      headers: {
        "content-type": "application/json",
        ...(init?.headers || {})
      }
    });
  } catch (error) {
    throw new KernelRequestError(
      `暂时无法连接音频内核：${error instanceof Error ? error.message : "network error"}`,
      null,
      true
    );
  }
  const payload = (await response.json().catch(() => ({}))) as { detail?: string; error?: string };
  if (!response.ok) {
    throw new KernelRequestError(
      payload.detail || payload.error || `内核请求失败：HTTP ${response.status}`,
      response.status,
      response.status === 408 || response.status === 429 || response.status >= 500 || Number(response.headers.get("retry-after")) > 0,
      response.headers.get("x-kernel-job-accepted") === "false",
      Number(response.headers.get("retry-after")) > 0 ? Number(response.headers.get("retry-after")) : undefined
    );
  }
  return payload as T;
}

function kernelRequestTimeoutMs(fallback = 15_000): number {
  const configured = Number(process.env.KERNEL_REQUEST_TIMEOUT_MS || fallback);
  if (!Number.isFinite(configured)) {
    return fallback;
  }
  return Math.max(1_000, Math.min(120_000, configured));
}
