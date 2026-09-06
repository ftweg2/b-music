import { ApiError } from "./api";
import { NextResponse } from "next/server";
import { KernelRequestError } from "./kernelClient";
import { sanitizeText } from "./sanitize";

export function loginErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) throw error;
  const kernel = error instanceof KernelRequestError ? error : null;
  const status = !kernel ? 400 : kernel.code === "KERNEL_REQUEST_TIMEOUT" ? 504 :
    [409, 429, 503, 504].includes(kernel.status || 0) ? kernel.status! : 502;
  const code = kernel?.code || (status === 409 ? "KERNEL_PROFILE_BUSY" : kernel ? "KERNEL_UNAVAILABLE" : "INVALID_LOGIN_REQUEST");
  const message = kernel?.code === "KERNEL_REQUEST_TIMEOUT" ? "二维码服务响应超时，请稍后重试；已有待扫码会话会被复用。" :
    error instanceof Error ? error.message : error;
  return NextResponse.json({ error: sanitizeText(message), code, retryable: kernel?.retryable || false }, {
    status, headers: kernel?.retryable ? { "retry-after": String(Math.max(1, Math.min(60, kernel.retryAfterSeconds || 3))) } : undefined,
  });
}
