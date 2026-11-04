# Creative Studio: AI Ads Manager slice

From a store URL to full-screen 9:16 interstitial ads a marketer would actually run. The agent researches the store, proposes a brief the marketer confirms, generates ads around the store's real product photos, and iterates on feedback.

## How it works

```
URL ─▶ research (Shopify storefront JSON + homepage) ─▶ brief (LLM judgment, human confirms)
    ─▶ per ad: copy (LLM, grounded) ─▶ guide canvas ─▶ scene (fal) ─▶ product paste-back ─▶ QA (vision)
    ─▶ text layer (satori, brand font/colors) ─▶ Supabase Storage ─▶ review / edit / feedback / approve
```

- **Research** (`src/lib/research`): `/products.json`, `/meta.json`, best-seller order read from `/collections/all?sort_by=best-selling` (the JSON endpoint ignores `sort_by`), with a fallback to curated best-seller collections and then to homepage order. Logo, colors and heading font come from the theme HTML. Ratings come from product-page JSON-LD, and claims are extracted from store copy. Every brand-kit field records where it came from (`scraped`, `inferred`, `user`, `default` or `missing`).
- **Generation** (`src/lib/generation`, `src/lib/render`): a layout defines the product rectangle and the quiet text zones. The same definition builds the guide canvas sent to fal and positions the text layer afterwards. After generation, the original product pixels are pasted back when alignment allows. The image model never draws text.
- **Agent** (`src/lib/agent`, `src/app/api/chat`): AI SDK 7 `streamText` with streaming tools (`researchStore`, `generateAds`, `reviseAd`) and one client-side tool (`confirmBrief`). The client-side tool is the human checkpoint before anything is generated.
- **Data** (`supabase/migrations`): brands, brand kits, research runs, products, images, facts, campaigns, ads, ad versions (`ad_variants`), feedback, messages and assets. Access is server-only (RLS on, no policies).

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in values
pnpm dev
```

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Postgres + Storage (server only) |
| `FAL_KEY` | Scene generation. Without it, ads fall back to a studio backdrop |
| `AI_GATEWAY_API_KEY` | LLM calls locally (on Vercel, OIDC is used automatically) |
| `AGENT_MODEL`, `FAST_MODEL`, `FAL_SCENE_MODEL` | Optional model overrides |

Apply `supabase/migrations/0001_init.sql` to a fresh project; it also creates the public `assets` bucket.

### Scripts

- `node --conditions=react-server --import tsx scripts/render-smoke.mts <dir>`: offline render pipeline check (guide, paste-back, text layer).
- `node --conditions=react-server --import tsx scripts/research-probe.mts loopycases.com`: run the research parsers against a live store.
