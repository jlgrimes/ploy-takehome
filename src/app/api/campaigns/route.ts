import { NextResponse } from "next/server";
import { db, must } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";
import { normalizeStoreUrl } from "@/lib/research/shopify";

// Start a campaign from a URL. Research itself runs inside the agent (so it streams
// into the chat); this only creates the rows the chat attaches to.
export async function POST(req: Request) {
  const { url } = (await req.json()) as { url?: string };
  let target;
  try {
    target = normalizeStoreUrl(url ?? "");
  } catch {
    return NextResponse.json({ error: "Enter a store URL like loopycases.com" }, { status: 400 });
  }
  const brand = must(
    await db().from("brands").upsert({ owner_id: DEMO_USER_ID, domain: target.domain, updated_at: new Date().toISOString() }, { onConflict: "owner_id,domain" }).select("id").single(),
    "upsert brand",
  ) as { id: string };
  const campaign = must(
    await db().from("campaigns").insert({ owner_id: DEMO_USER_ID, brand_id: brand.id, name: target.domain.replace(/^www\./, ""), status: "draft" }).select("id").single(),
    "insert campaign",
  ) as { id: string };
  return NextResponse.json({ id: campaign.id, url: url!.trim() });
}

export async function GET() {
  const { data } = await db()
    .from("campaigns")
    .select("id, name, status, created_at, brand:brands(domain, name), ads(id, status)")
    .eq("owner_id", DEMO_USER_ID)
    .order("created_at", { ascending: false })
    .limit(20);
  return NextResponse.json({ campaigns: data ?? [] });
}
