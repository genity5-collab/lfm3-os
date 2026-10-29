/**
 * Optional private search proxy for LFM3 OS.
 *
 * The app works without this (it falls back to DuckDuckGo and Wikipedia through
 * a public reader). Deploy this on your own Cloudflare Workers free plan when you
 * want a search endpoint that is yours, uncached and rate-limit free:
 *
 *   1. npm i -g wrangler
 *   2. wrangler deploy search-worker.js --name lfm3-search
 *   3. Open LFM3 OS → Settings → Web search → paste
 *      https://lfm3-search.<your-subdomain>.workers.dev
 *
 * The app calls it as:  GET <worker>?q=your+query
 * and expects:          { "results": [ { "title", "url", "snippet" } ] }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

function unwrap(url) {
  const m = url.match(/[?&]uddg=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : url;
}

function parse(html, limit = 8) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    out.push({ title, url: unwrap(m[1]), snippet: '' });
  }
  // Lite layout fallback
  if (!out.length) {
    const rows = [...html.matchAll(/<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    for (const r of rows.slice(0, limit)) {
      out.push({
        title: r[2].replace(/<[^>]+>/g, '').trim(),
        url: unwrap(r[1]),
        snippet: '',
      });
    }
  }
  // Attach snippets where the markup allows it
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((s) =>
    s[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 260)
  );
  snippets.forEach((sn, i) => {
    if (out[i]) out[i].snippet = sn;
  });
  return out;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const q = new URL(request.url).searchParams.get('q');
    if (!q) return json({ error: 'missing ?q=' }, 400);

    const target = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
    try {
      const upstream = await fetch(target, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!upstream.ok) return json({ error: 'upstream ' + upstream.status }, 502);
      const html = await upstream.text();
      const results = parse(html);
      if (!results.length) return json({ error: 'no results parsed' }, 502);
      return json({ query: q, results }, 200);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
