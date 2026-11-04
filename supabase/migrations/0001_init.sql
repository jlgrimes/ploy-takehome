-- AI Ads Manager: initial schema.
-- Access model: no end-user auth. The Next.js server talks to Postgres with the
-- service role key; RLS is enabled with no policies so the anon key can read nothing.
-- owner_id is stamped with a hard-coded demo user id so real auth can slot in later.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Files (everything we persist to Storage)
-- ---------------------------------------------------------------------------
create table assets (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null,
  brand_id    uuid,
  kind        text not null check (kind in ('logo','product_image','guide','scene','render','upload')),
  bucket      text not null default 'assets',
  path        text not null unique,
  public_url  text not null,
  mime        text,
  width       int,
  height      int,
  bytes       int,
  sha256      text,
  source_url  text,            -- where it came from (store CDN, fal URL)
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Research layer
-- ---------------------------------------------------------------------------
create table brands (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null,
  domain       text not null,                 -- normalized, e.g. www.loopycases.com
  name         text,
  platform     text not null default 'unknown' check (platform in ('shopify','unknown')),
  shop_domain  text,                          -- x.myshopify.com
  currency     text,
  status       text not null default 'new' check (status in ('new','researching','ready','failed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (owner_id, domain)
);
alter table assets add constraint assets_brand_fk foreign key (brand_id) references brands(id) on delete cascade;

create table brand_kits (
  brand_id        uuid primary key references brands(id) on delete cascade,
  logo_asset_id   uuid references assets(id) on delete set null,
  logo_source_url text,
  colors          jsonb not null default '[]',   -- [{hex, role: primary|background|ink|accent}]
  fonts           jsonb not null default '[]',   -- [{family, role}]
  voice           jsonb,                         -- {adjectives: [], example: ''}
  value_prop      text,
  selling_points  jsonb not null default '[]',   -- [string]
  provenance      jsonb not null default '{}',   -- {field: {source: scraped|inferred|user|default|missing, url?}}
  updated_at      timestamptz not null default now()
);

create table research_runs (
  id           uuid primary key default gen_random_uuid(),
  brand_id     uuid not null references brands(id) on delete cascade,
  status       text not null default 'running' check (status in ('running','succeeded','partial','failed')),
  steps        jsonb not null default '[]',      -- [{key, status: ok|degraded|failed|skipped, ms, detail}]
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create table products (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references brands(id) on delete cascade,
  external_id       text,
  handle            text not null,
  title             text not null,
  description       text,
  product_type      text,
  vendor            text,
  tags              text[] not null default '{}',
  price             numeric,
  compare_at_price  numeric,
  available         boolean,
  best_seller_rank  int,                         -- 1 = top seller; null = unknown
  url               text,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  unique (brand_id, handle)
);

create table product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  source_url  text not null,
  width       int,
  height      int,
  alt         text,
  position    int,
  kind        text not null default 'unknown' check (kind in ('lifestyle','packshot','unknown')),
  asset_id    uuid references assets(id) on delete set null,  -- set only once copied to Storage
  unique (product_id, source_url)
);

-- The only claims an ad is allowed to state. Copy references these by id.
create table brand_facts (
  id           uuid primary key default gen_random_uuid(),
  brand_id     uuid not null references brands(id) on delete cascade,
  product_id   uuid references products(id) on delete cascade,
  kind         text not null,      -- rating | review_count | warranty | returns | shipping | founded | other
  text         text not null,      -- human phrasing, e.g. '70,000+ five-star reviews'
  value        jsonb,
  source_url   text,
  source_kind  text,               -- meta_description | json_ld | product_body | user
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Creative layer
-- ---------------------------------------------------------------------------
create table campaigns (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null,
  brand_id            uuid not null references brands(id) on delete cascade,
  name                text not null,
  status              text not null default 'draft'
                      check (status in ('draft','researching','brief_pending','generating','in_review','completed')),
  brief               jsonb,       -- {products:[{productId,reason}], angles, offer, voice, avoid, cta}
  brief_confirmed_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table ads (
  id                   uuid primary key default gen_random_uuid(),
  campaign_id          uuid not null references campaigns(id) on delete cascade,
  product_id           uuid references products(id) on delete set null,
  angle                text not null,
  layout               text not null,
  position             int not null default 0,
  status               text not null default 'pending'
                       check (status in ('pending','generating','needs_review','approved','rejected','failed')),
  approved_variant_id  uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table feedback (
  id                 uuid primary key default gen_random_uuid(),
  ad_id              uuid not null references ads(id) on delete cascade,
  variant_id         uuid,                      -- the version the feedback was about
  text               text not null,
  kind               text check (kind in ('copy','scene','brief')),   -- classified by the agent
  interpretation     jsonb,                     -- what the agent decided to change
  result_variant_id  uuid,                      -- the version it produced
  created_at         timestamptz not null default now()
);

create table ad_variants (
  id                  uuid primary key default gen_random_uuid(),
  ad_id               uuid not null references ads(id) on delete cascade,
  version             int not null,
  parent_variant_id   uuid references ad_variants(id) on delete set null,
  change_type         text not null check (change_type in ('initial','copy_edit','scene_regen','brief_change')),
  feedback_id         uuid references feedback(id) on delete set null,
  copy                jsonb not null,           -- {headline, subline, cta, factIds: []}
  reference_image_id  uuid references product_images(id) on delete set null,
  guide_asset_id      uuid references assets(id) on delete set null,
  scene_asset_id      uuid references assets(id) on delete set null,
  render_asset_id     uuid references assets(id) on delete set null,
  gen                 jsonb,                    -- {strategy, model, prompt, falRequestId, ms, costUsd}
  qa                  jsonb,                    -- {checks: [{key, pass, detail}]}
  status              text not null default 'queued'
                      check (status in ('queued','generating_scene','rendering','ready','failed')),
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (ad_id, version)
);

alter table ads add constraint ads_approved_variant_fk
  foreign key (approved_variant_id) references ad_variants(id) on delete set null;
alter table feedback add constraint feedback_variant_fk
  foreign key (variant_id) references ad_variants(id) on delete set null;
alter table feedback add constraint feedback_result_variant_fk
  foreign key (result_variant_id) references ad_variants(id) on delete set null;

-- Chat history (AI SDK UIMessage shape)
create table messages (
  id           text primary key,
  campaign_id  uuid not null references campaigns(id) on delete cascade,
  role         text not null,
  parts        jsonb not null,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index on products (brand_id, best_seller_rank);
create index on product_images (product_id, position);
create index on brand_facts (brand_id);
create index on campaigns (brand_id, created_at desc);
create index on ads (campaign_id, position);
create index on ad_variants (ad_id, version desc);
create index on feedback (ad_id, created_at);
create index on messages (campaign_id, created_at);
create index on research_runs (brand_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Lock down: server-only access via service role.
-- ---------------------------------------------------------------------------
alter table assets         enable row level security;
alter table brands         enable row level security;
alter table brand_kits     enable row level security;
alter table research_runs  enable row level security;
alter table products       enable row level security;
alter table product_images enable row level security;
alter table brand_facts    enable row level security;
alter table campaigns      enable row level security;
alter table ads            enable row level security;
alter table feedback       enable row level security;
alter table ad_variants    enable row level security;
alter table messages       enable row level security;

-- Public bucket: finished creatives and references are meant to be viewable by URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assets', 'assets', true, 20971520, array['image/png','image/jpeg','image/webp','image/svg+xml','image/gif','image/avif'])
on conflict (id) do nothing;
