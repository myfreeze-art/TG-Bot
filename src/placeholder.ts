// Placeholder for the first deploy via GitHub (Cloudflare Workers Builds).
// The real bot and all features live in src/index.ts and are enabled by ONE line
// in wrangler.dashboard.jsonc:
//
//   "main": "src/index.ts"      (back to placeholder: "main": "src/placeholder.ts")
//
// Secrets (BOT_TOKEN etc.) are NOT stored here: set them in Cloudflare Settings -> Variables.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'anon-msg-bot',
        mode: 'placeholder',
        hint: 'Enable the bot: "main": "src/index.ts" in wrangler.dashboard.jsonc',
      });
    }

    return new Response(
      'anon-msg-bot: placeholder is running. Set "main" to "src/index.ts" in wrangler.dashboard.jsonc to enable the bot.',
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },

  async scheduled(): Promise<void> {
    // No-op while src/index.ts is not enabled.
  },
};
