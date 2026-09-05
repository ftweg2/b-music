import { redirect } from "next/navigation";
import { DiscoveryHome } from "@/components/DiscoveryHome";

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  // Preserve bookmarks from the former inline home search.
  if (typeof query.q === "string" && query.q.trim()) {
    const params = new URLSearchParams();
    for (const key of ["q", "remote", "provider", "limit", "page", "searchId", "sessionKey"]) if (typeof query[key] === "string") params.set(key, query[key]);
    redirect("/search?" + params);
  }
  return <DiscoveryHome />;
}
