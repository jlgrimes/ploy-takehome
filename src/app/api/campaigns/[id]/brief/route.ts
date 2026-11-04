import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const briefSchema = z.object({
  concepts: z
    .array(z.object({ productId: z.string().uuid(), angle: z.enum(["benefit", "social_proof", "lifestyle", "feature", "offer", "gift"]), why: z.string().max(300) }))
    .min(1)
    .max(4),
  offer: z.string().trim().max(60).nullable(),
  voice: z.object({ adjectives: z.array(z.string().max(30)).max(5), example: z.string().max(200) }),
  valueProp: z.string().max(200),
  avoid: z.array(z.string().max(60)).max(20),
  cta: z.string().trim().min(1).max(24),
});

// Save the marketer's edits to the brief and mark it confirmed. Voice edits are also
// written back to the brand kit with provenance "user" so re-research never overwrites them.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = briefSchema.safeParse((await req.json()).brief);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid brief" }, { status: 400 });
  const brief = { ...parsed.data, offer: parsed.data.offer || null };
  const { data: c, error } = await db()
    .from("campaigns")
    .update({ brief, brief_confirmed_at: new Date().toISOString(), status: "generating", updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("brand_id, brief")
    .single();
  if (error || !c) return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  const { data: kit } = await db().from("brand_kits").select("voice, value_prop, provenance").eq("brand_id", c.brand_id).maybeSingle();
  if (kit) {
    const prov = { ...(kit.provenance as Record<string, unknown>) };
    const voiceChanged = JSON.stringify(kit.voice) !== JSON.stringify(brief.voice);
    const vpChanged = kit.value_prop !== brief.valueProp;
    if (voiceChanged) prov.voice = { source: "user" };
    if (vpChanged) prov.valueProp = { source: "user" };
    if (voiceChanged || vpChanged) await db().from("brand_kits").update({ voice: brief.voice, value_prop: brief.valueProp, provenance: prov }).eq("brand_id", c.brand_id);
  }
  return NextResponse.json({ ok: true });
}
