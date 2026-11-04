import { notFound } from "next/navigation";
import { Workspace } from "@/components/studio/workspace";
import type { StudioMessage } from "@/components/studio/chat-panel";
import { getCampaignState } from "@/lib/campaign-state";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ start?: string }> }) {
  const { id } = await params;
  const { start } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const state = await getCampaignState(id);
  if (!state) notFound();
  const { data } = await db().from("messages").select("id, role, parts").eq("campaign_id", id).order("created_at");
  const messages = (data ?? []) as StudioMessage[];
  return <Workspace initialState={state} initialMessages={messages} startUrl={start ?? null} />;
}
