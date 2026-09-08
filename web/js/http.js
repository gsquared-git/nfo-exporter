/**
 * Rate-limited, retrying, cancellable fetcher — the browser counterpart of
 * WebClient in sources.py.
 *
 * Two things differ from the desktop tool:
 *
 *  - Content-Encoding is the browser's problem, not ours, so decode_body has no
 *    equivalent here.
 *  - Cross-origin rules. A page cannot read a response that carries no
 *    Access-Control-Allow-Origin header, and neither MyAnimeList nor TheTVDB
 *    sends one. Those two go through the Cloudflare Worker in worker/; the
 *    Wikipedia API sets the header itself when asked with origin=*, so it is
 *    fetched directly and needs no proxy at all.
 */

import { Cancelled, ScrapeError, sleep } from './util.js';

const PROXY_KEY = 'nfoExporter.proxyUrl';

/** Hosts that will not talk to a browser directly. */
const NEEDS_PROXY = /(^|\.)(myanimelist\.net|thetvdb\.com)$/i;

export function getProxyUrl() {
  try {
    return localStorage.getItem(PROXY_KEY) || '';
  } catch {
    return '';
  }
}

export function setProxyUrl(url) {
  try {
    if (url) localStorage.setItem(PROXY_KEY, url);
    else localStorage.removeItem(PROXY_KEY);
  } catch {
    /* private mode — the field still works for this session */
  }
}

export function needsProxy(url) {
  try {
    return NEEDS_PROXY.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Wrap a URL in the configured proxy when its host requires one. */
export function routeUrl(url) {
  if (!needsProxy(url)) return url;
  const proxy = getProxyUrl();
  if (!proxy) {
    throw new ScrapeError(
      `${new URL(url).hostname} blocks direct browser requests (no CORS header). ` +
        'Set a proxy URL in Settings, or use the Wikipedia source, which needs none.',
    );
  }
  const base = proxy.replace(/\?.*$/, '').replace(/\/+$/, '');
  return `${base}/?url=${encodeURIComponent(url)}`;
}

/** Sliding-window limiter, ported from RateLimiter in sources.py. */
class RateLimiter {
  constructor(perSecond, perMinute, signal) {
    this.minGap = 1000 / perSecond;
    this.perMinute = perMinute;
    this.signal = signal;
    this.stamps = [];
  }

  async acquire() {
    for (;;) {
      if (this.signal && this.signal.aborted) throw new Cancelled();
      const now = performance.now();
      this.stamps = this.stamps.filter((t) => now - t < 60000);
      let wait = 0;
      if (this.stamps.length) {
        wait = Math.max(wait, this.minGap - (now - this.stamps[this.stamps.length - 1]));
      }
      if (this.stamps.length >= this.perMinute) {
        wait = Math.max(wait, 60000 - (now - this.stamps[0]) + 50);
      }
      if (wait <= 0) {
        this.stamps.push(now);
        return;
      }
      await sleep(Math.min(wait, 250), this.signal);
    }
  }
}

export class WebClient {
  static perSecond = 1.0;
  static perMinute = 30;
  static accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  constructor({ signal = null, log = () => {} } = {}) {
    this.signal = signal;
    this.log = log;
    this.limiter = new RateLimiter(
      this.constructor.perSecond,
      this.constructor.perMinute,
      signal,
    );
  }

  get cancelled() {
    return Boolean(this.signal && this.signal.aborted);
  }

  checkCancelled() {
    if (this.cancelled) throw new Cancelled();
  }

  /**
   * One request, with the same retry policy as the Python version: 404 and
   * 401/403 are final, 429 and 5xx are retried with a growing backoff.
   */
  async request(url, { method = 'GET', body = null, contentType = '', retries = 4, raw = false } = {}) {
    const routed = routeUrl(url);
    let lastError = 'unknown error';

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      await this.limiter.acquire();
      this.checkCancelled();

      // Any non-simple header forces a CORS preflight. The Worker answers
      // OPTIONS; Wikipedia is fetched directly and is left with a simple
      // request so no preflight is needed there.
      const headers = {};
      if (routed !== url) headers['X-Proxy-Accept'] = this.constructor.accept;
    

      let retryable = false;
      try {
        const response = await fetch(routed, {
          method,
          headers,
          body,
          signal: this.signal,
          redirect: 'follow',
          cache: 'default',
        });

        if (response.ok) {
          return raw ? await response.arrayBuffer() : await response.text();
        }

        if (response.status === 404) throw new ScrapeError(`Not found: ${url}`);
        if (response.status === 401 || response.status === 403) {
          throw new ScrapeError(`Refused (HTTP ${response.status}): ${url}`);
        }
        lastError = `HTTP ${response.status}`;
        retryable = response.status === 429 || response.status >= 500;
      } catch (err) {
        if (err instanceof ScrapeError) throw err;
        if (err instanceof Cancelled || err.name === 'AbortError') throw new Cancelled();
        // A CORS rejection surfaces as an opaque TypeError with no detail.
        lastError = `network error: ${err.message || err}`;
        retryable = true;
      }

      if (!retryable || attempt === retries) break;
      const backoff = Math.min(2500 * attempt, 15000);
      this.log(`  ${lastError} - retrying in ${Math.round(backoff / 1000)}s (${attempt}/${retries - 1})`);
      await sleep(backoff, this.signal);
    }

    throw new ScrapeError(`${lastError} for ${url}`);
  }

  get(url, retries = 4) {
    return this.request(url, { retries });
  }

  async getJson(url, retries = 4) {
    const text = await this.get(url, retries);
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ScrapeError(`Bad JSON from ${url}: ${err.message}`);
    }
  }

  async postJson(url, payload, retries = 3) {
    const text = await this.request(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      contentType: 'application/json',
      retries,
    });
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ScrapeError(`Bad JSON from ${url}: ${err.message}`);
    }
  }

  /** Fetch an image as bytes, for writing straight into the output folder. */
  async downloadBytes(url) {
    this.checkCancelled();
    const buffer = await this.request(url, { retries: 2, raw: true });
    return new Uint8Array(buffer);
  }
}

/** Quick reachability check for the Settings panel. */
export async function testProxy(url) {
  const base = url.replace(/\?.*$/, '').replace(/\/+$/, '');
  const target = 'https://myanimelist.net/anime/1';
  const response = await fetch(`${base}/?url=${encodeURIComponent(target)}`, {
    method: 'GET',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Proxy replied HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!/Cowboy Bebop|myanimelist/i.test(text)) {
    throw new Error('Proxy replied, but the page did not look like MyAnimeList.');
  }
  return true;
}
