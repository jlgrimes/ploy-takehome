import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { editCopy } from "@/lib/generation/pipeline";

export const maxDuration = 60;

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), variantId: z.string().uuid() }),
  z.object({ action: z.literal("unapprove") }),
  z.object({ action: z.literal("reject") }),
  z.object({
    action: z.literal("editCopy"),
    variantId: z.string().uuid().optional(),
    copy: z.object({ headline: z.string().trim().min(1).max(60), subline: z.string().trim().max(90).nullable().optional(), cta: z.string().trim().min(1).max(24) }),
  }),
]);

// Direct manipulation from the ads board. Approve/reject are instant; a copy edit
// re-renders the text layer over the same scene (no image generation).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const now = new Date().toISOString();
  const b = parsed.data;
  if (b.action === "approve") {
    await db().from("ads").update({ status: "approved", approved_variant_id: b.variantId, updated_at: now }).eq("id", id);
  } else if (b.action === "unapprove") {
    await db().from("ads").update({ status: "needs_review", approved_variant_id: null, updated_at: now }).eq("id", id);
  } else if (b.action === "reject") {
    await db().from("ads").update({ status: "rejected", approved_variant_id: null, updated_at: now }).eq("id", id);
  } else {
    const res = await editCopy({ adId: id, variantId: b.variantId, copy: { headline: b.copy.headline, subline: b.copy.subline ?? null, cta: b.copy.cta, factIds: [] } });
    if ("error" in res && res.error) return NextResponse.json({ error: res.error }, { status: 500 });
    return NextResponse.json({ ok: true, variantId: res.variantId });
  }
  return NextResponse.json({ ok: true });
}
