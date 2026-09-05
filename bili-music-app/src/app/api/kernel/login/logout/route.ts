import { apiEndpoint, apiOptions, ApiError, readJsonObject } from "@/lib/api";
import { NextResponse } from "next/server";
import { assertAccountContext, clearAppOwnerCookies } from "@/lib/appOwner";
import { logoutDefaultKernelProfile } from "@/lib/kernelSession";
import { loginErrorResponse } from "@/lib/loginApi";
export const runtime = "nodejs";

async function postHandler(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (body?.confirmed !== true) throw new Error("退出登录需要明确确认");
    await assertAccountContext();
    await logoutDefaultKernelProfile();
    const response = NextResponse.json({ loggedIn: false, message: "已退出 Bilibili；本地收藏、关注和歌单均已保留" });
    clearAppOwnerCookies(response);
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error; return loginErrorResponse(error); }
}

export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["POST"]);
