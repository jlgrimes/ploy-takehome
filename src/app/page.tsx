import Link from "next/link";
import { ImageIcon, Sparkles, Store, Wand2 } from "lucide-react";
import { NewCampaignForm } from "@/components/studio/new-campaign-form";
import { db } from "@/lib/db";
import { DEMO_USER_ID } from "@/lib/constants";

export const dynamic = "force-dynamic";

type Row = { id: string; name: string; status: string; created_at: string; brand: { domain: string; name: string | null } | null; ads: { id: string; status: string }[] };

const STATUS: Record<string, string> = {
  draft: "Starting",
  researching: "Researching",
  brief_pending: "Brief ready",
  generating: "Generating",
  in_review: "In review",
  completed: "Completed",
};

async function recentCampaigns(): Promise<Row[]> {
  try {
    const { data } = await db()
      .from("campaigns")
      .select("id, name, status, created_at, brand:brands(domain, name), ads(id, status)")
      .eq("owner_id", DEMO_USER_ID)
      .order("created_at", { ascending: false })
      .limit(8);
    return (data ?? []) as unknown as Row[];
  } catch {
    return [];
  }
}

export default async function Home() {
  const campaigns = await recentCampaigns();
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-10 sm:px-6 sm:py-16">
      <header className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="size-4" />
        </span>
        Ads Manager · Creative Studio
      </header>

      <section className="mt-16 max-w-2xl sm:mt-24">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Turn your store into ads you’d actually run.</h1>
        <p className="mt-4 text-lg text-pretty text-muted-foreground">
          Paste your store URL. The agent studies your brand and best sellers, proposes a brief for you to confirm, then builds full-screen 9:16 ads from your real product photos.
        </p>
        <NewCampaignForm className="mt-8" />
        <p className="mt-3 text-xs text-muted-foreground">Works best with Shopify stores. Other platforms: paste a product page link.</p>
      </section>

      <section className="mt-16 grid gap-4 sm:grid-cols-3">
        {[
          { icon: Store, title: "Research", body: "Catalog, best sellers, logo, colors, ratings. Every claim traced to its source." },
          { icon: Wand2, title: "Generate", body: "Your real product, in a new scene. Copy drawn in your brand font, never by the image model." },
          { icon: ImageIcon, title: "Manage", body: "Edit copy instantly, give feedback, compare versions, approve." },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-2xl border bg-card p-5">
            <Icon className="size-5 text-brand" />
            <h3 className="mt-3 font-medium">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>

      <section className="mt-16">
        <h2 className="text-sm font-medium text-muted-foreground">Recent campaigns</h2>
        {campaigns.length ? (
          <ul className="mt-3 divide-y rounded-2xl border bg-card">
            {campaigns.map((c) => {
              const approved = c.ads.filter((a) => a.status === "approved").length;
              return (
                <li key={c.id}>
                  <Link href={`/c/${c.id}`} className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-muted/50">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.brand?.name ?? c.brand?.domain ?? c.name}</p>
                      <p className="truncate text-sm text-muted-foreground">{c.brand?.domain}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
                      {c.ads.length ? <span>{approved}/{c.ads.length} approved</span> : null}
                      <span className="rounded-full border px-2.5 py-0.5 text-xs">{STATUS[c.status] ?? c.status}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">No campaigns yet. Paste a store URL above to create your first set of ads.</p>
        )}
      </section>
    </main>
  );
}
