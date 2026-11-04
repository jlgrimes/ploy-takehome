import { NextResponse } from "next/server";
import { getCampaignState } from "@/lib/campaign-state";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = await getCampaignState(id);
  if (!state) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
}
