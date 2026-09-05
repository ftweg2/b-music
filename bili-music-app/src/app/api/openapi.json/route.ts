import { apiEndpoint, apiOptions } from "@/lib/api";
import { openApiDocument } from "@/lib/openapi";
export const runtime = "nodejs";
export const GET = apiEndpoint("GET", () => Response.json(openApiDocument()));
export const OPTIONS = apiOptions(["GET"]);
