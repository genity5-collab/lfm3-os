/**
 * Cloudflare Worker: one place to keep the model key server-side so every visitor
 * of your Pages site gets a working agent with no download and no key of their own.
 *
 * Deploy:
 *   npm create cloudflare@latest lfm3-ai -- --type=hello-world
 *   # replace src/index.js with this file
 *   npx wrangler secret put OPENAI_API_KEY     # any OpenAI-compatible provider
 *   # optional: npx wrangler secret put AI_GATEWAY_URL  (e.g. https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/groq)
 *   npx wrangler deploy
 *
 * Then in LFM3 OS -> Settings -> Engine: cloud, provider "Your own proxy",
 * Base URL = https://<worker>.workers.dev/v1, and any key text (the worker holds the real one).
 *
 * Cheaper and fully on Cloudflare: bind Workers AI instead of a provider key.
 * Add to wrangler.toml:  [ai] binding = "AI"
 * Set PROVIDER = "workers-ai" and MODEL to a model your plan can run.
 */

const ALLOWED_ORIGINS = [
  'https://genity5-collab.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const PROVIDER = 'openai'; // 'openai' | 'workers-ai'
const DEFAULT_MODEL = 'openai/gpt-oss-20b';

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'content-type,authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors(origin) },
  });

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, origin);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400, origin);
    }

    const messages = Array.isArray(payload.messages) ? payload.messages.slice(-24) : null;
    if (!messages) return json({ error: 'messages[] required' }, 400, origin);

    const body = {
      model: payload.model || DEFAULT_MODEL,
      messages,
      stream: payload.stream !== false,
      temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.3,
      max_tokens: Math.min(Math.max(Number(payload.max_tokens) || 900, 256), 4096),
    };

    if (PROVIDER === 'workers-ai') {
      const run = await env.AI.run(body.model, {
        messages,
        stream: body.stream,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
      });
      if (body.stream) {
        return new Response(run, {
          headers: { 'content-type': 'text/event-stream', ...cors(origin) },
        });
      }
      return json(run, 200, origin);
    }

    const base = env.AI_GATEWAY_URL || 'https://api.groq.com/openai/v1';
    const upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const headers = new Headers(upstream.headers);
    const pass = cors(origin);
    Object.entries(pass).forEach(([k, v]) => headers.set(k, v));
    headers.delete('content-encoding');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
