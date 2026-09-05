import { ApiError } from "./api";
import { NextResponse } from "next/server";
import { KernelRequestError } from "./kernelClient";
import { sanitizeText } from "./sanitize";

export function loginErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) throw error;
  const status = error instanceof KernelRequestError ? error.status === 409 ? 409 : 502 : 400;
  return NextResponse.json({ error: sanitizeText(error instanceof Error ? error.message : error), code: status === 409 ? "KERNEL_PROFILE_BUSY" : status === 502 ? "KERNEL_UNAVAILABLE" : "INVALID_LOGIN_REQUEST", retryable: error instanceof KernelRequestError && error.retryable }, { status, headers: error instanceof KernelRequestError && error.retryable ? { "retry-after": "2" } : undefined });
}
