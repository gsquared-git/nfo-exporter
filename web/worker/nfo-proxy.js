/**
 * CORS proxy for the Emby NFO Exporter web app.
 *
 * MyAnimeList and TheTVDB send no Access-Control-Allow-Origin header, so a page
 * on github.io cannot read their responses no matter how the request is made.
 * This Worker fetches them server-side and hands the body back with CORS headers
 * attached.
 *
 * It is deliberately not a general-purpose open proxy: only the hosts in
 * ALLOWED_HOSTS can be reached, so the worst it can be abused for is scraping
 * the same three public sites the app already scrapes.
 *
 * Usage:  GET|POST  https://<worker>/?url=<url-encoded absolute URL>
 *
 * Optional environment variable:
 *   ALLOWED_ORIGINS   comma-separated list of page origins allowed to call it,
 *                     e.g. "https://you.github.io". Unset means any origin.
 */

const ALLOWED_HOSTS = new Set([
  'myanimelist.net',
  'www.myanimelist.net',
  'cdn.myanimelist.net',
  'api-cdn.myanimelist.net',
  'thetvdb.com',
  'www.thetvdb.com',
  'api4.thetvdb.com',
  'artworks.thetvdb.com',
  'en.wikipedia.org',
  'upload.wikimedia.org',
]);

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MAX_BODY = 8 * 1024 * 1024; // 8 MB — no page or poster is anywhere near this

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowList = (env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let allow = '*';
  if (allowList.length) {
    allow = allowList.includes(origin) ? origin : allowList[0];
  } else if (origin) {
    allow = origin;
  }

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Accept',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'X-Proxy-Status, X-Proxy-Url',
    Vary: 'Origin',
  };
}

function originAllowed(request, env) {
  const allowList = (env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowList.length) return true;
  const origin = request.headers.get('Origin') || '';
  return !origin || allowList.includes(origin);
}

function fail(request, env, status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const here = new URL(request.url);

    // A bare visit in a browser: say what this is rather than 400.
    if (here.pathname === '/' && !here.searchParams.has('url')) {
      return new Response(
        'Emby NFO Exporter CORS proxy. Call it as /?url=<encoded absolute URL>.\n' +
          'Reachable hosts: ' +
          [...ALLOWED_HOSTS].join(', ') +
          '\n',
        { status: 200, headers: { 'Content-Type': 'text/plain', ...corsHeaders(request, env) } },
      );
    }

    if (!originAllowed(request, env)) {
      return fail(request, env, 403, 'This proxy is not open to that origin.');
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return fail(request, env, 405, 'Only GET and POST are proxied.');
    }

    const raw = here.searchParams.get('url');
    if (!raw) return fail(request, env, 400, 'Missing ?url= parameter.');

    let target;
    try {
      target = new URL(raw);
    } catch {
      return fail(request, env, 400, `Not a valid URL: ${raw}`);
    }

    if (target.protocol !== 'https:') {
      return fail(request, env, 400, 'Only https:// targets are proxied.');
    }
    if (!ALLOWED_HOSTS.has(target.hostname)) {
      return fail(
        request,
        env,
        403,
        `Host not on the allowlist: ${target.hostname}. ` +
          `Allowed: ${[...ALLOWED_HOSTS].join(', ')}`,
      );
    }

    const headers = new Headers({
      'User-Agent': BROWSER_UA,
      Accept:
        request.headers.get('X-Proxy-Accept') ||
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${target.protocol}//${target.hostname}/`,
    });

    let body = null;
    if (request.method === 'POST') {
      body = await request.text();
      headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
      headers.set('Accept', 'application/json, text/plain, */*');
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method: request.method,
        headers,
        body,
        redirect: 'follow',
        // Cache GETs at the edge: re-running an export for the same series
        // should not hammer the upstream site again.
        cf: request.method === 'GET' ? { cacheTtl: 300, cacheEverything: true } : undefined,
      });
    } catch (err) {
      return fail(request, env, 502, `Upstream fetch failed: ${err && err.message}`);
    }

    const outHeaders = new Headers(corsHeaders(request, env));
    const contentType = upstream.headers.get('Content-Type');
    if (contentType) outHeaders.set('Content-Type', contentType);
    const length = upstream.headers.get('Content-Length');
    if (length) {
      if (Number(length) > MAX_BODY) {
        return fail(request, env, 413, `Upstream response too large: ${length} bytes.`);
      }
      outHeaders.set('Content-Length', length);
    }
    outHeaders.set('X-Proxy-Status', String(upstream.status));
    outHeaders.set('X-Proxy-Url', target.toString());
    outHeaders.set('Cache-Control', 'no-store');

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};
