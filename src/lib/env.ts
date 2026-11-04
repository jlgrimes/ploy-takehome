import "server-only";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  supabaseUrl: () => req("SUPABASE_URL"),
  supabaseSecretKey: () => req("SUPABASE_SECRET_KEY"),
  falKey: () => process.env.FAL_KEY ?? null,
  firecrawlKey: () => process.env.FIRECRAWL_API_KEY ?? null,
  // Model ids routed through the Vercel AI Gateway.
  agentModel: () => process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5.5",
  fastModel: () => process.env.FAST_MODEL ?? "anthropic/claude-haiku-5.5",
  sceneModel: () => process.env.FAL_SCENE_MODEL ?? "fal-ai/nano-banana-2/edit",
};
