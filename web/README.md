# Emby NFO Exporter — web version

The Python tool, rewritten in JavaScript so it runs as a page on GitHub Pages
and writes NFO files straight into a folder you pick. No install, no Python, no
Pyodide — just the browser.

```
web/
  index.html          the app
  css/style.css
  js/
    util.js           text helpers, models          (port of the top of sources.py)
    http.js           rate limiting, retries, proxy routing  (port of WebClient)
    nfo.js            XML builders                  (port of the XML half of nfo_exporter.py)
    fs.js             File System Access output folder
    export.js         the export run                (port of run_export)
    app.js            UI wiring                     (replaces launch_gui)
    sources/          mal.js, tvdb.js, wikipedia.js
  worker/
    nfo-proxy.js      Cloudflare Worker: the CORS proxy
    wrangler.toml
```

The parsers, the NFO XML and the folder layout are ports, not rewrites. On the
fixture suite the JavaScript produces byte-identical NFO documents to
`nfo_exporter.py`, so a library built by one is indistinguishable from a library
built by the other.

---

## What's different from the desktop tool

**Output goes through a folder handle, not a path.** The browser asks you to
pick a folder once; it is remembered in IndexedDB, so later visits just need a
confirmation click. Everything under it — `<Show> (Year)/Season 01/<Show>
S01E01.nfo` — is written exactly as before.

This uses the File System Access API, which is **Chromium only**: Chrome, Edge,
Brave, Opera. Firefox and Safari have not shipped it and the app says so on
load.

**MyAnimeList and TheTVDB need a proxy.** Neither site sends an
`Access-Control-Allow-Origin` header, so a browser refuses to let the page read
the response — this is enforced by the browser and no amount of clever fetching
gets around it. `worker/nfo-proxy.js` fetches those two server-side and adds the
header. **Wikipedia needs nothing**: the MediaWiki API sets the header itself
when called with `origin=*`, so that source works the moment the page loads.

**Rate limits are per tab**, not per process, and the retry/backoff policy is
otherwise identical (404 and 403 are final, 429 and 5xx are retried four times).

---

## Deploying

### 1. The page

Push this repo to GitHub, then **Settings → Pages → Source: GitHub Actions**.
The workflow in `.github/workflows/pages.yml` publishes the `web/` folder on
every push to `main` that touches it. The site lands at
`https://<username>.github.io/<repo>/`.

Deploying from a branch works too — set Pages to serve from `/docs` and rename
`web/` to `docs/`. The workflow exists so the Python tool can stay in the repo
root without ending up on the public site.

### 2. The proxy

You need a free Cloudflare account. Nothing runs on it unless you use the app.

```bash
npm install -g wrangler
cd web/worker
wrangler login
wrangler deploy
```

That prints a URL like `https://nfo-proxy.<your-name>.workers.dev`. Paste it
into **Settings → CORS proxy URL** in the app and hit **Test proxy**.

To lock it to your own site, uncomment the `[vars]` block in `wrangler.toml`,
set `ALLOWED_ORIGINS` to your Pages origin, and deploy again. Without it the
Worker accepts any origin — the host allowlist inside it means the worst case is
someone else scraping the same three public sites.

The free plan's 100,000 requests/day is far more than this needs: a whole
multi-season series is one or two requests unless you turn on per-episode
detail.

#### Deploying without wrangler

Cloudflare dashboard → **Workers & Pages** → **Create** → **Worker** → **Deploy**,
then **Edit code**, paste the contents of `nfo-proxy.js`, and deploy. Add
`ALLOWED_ORIGINS` under Settings → Variables if you want it.

---

## Running it locally

ES modules need a real server; opening `index.html` from disk will not work.

```bash
cd web
python -m http.server 8000
```

Then <http://localhost:8000>. `localhost` counts as a secure context, so the
folder picker works there too.

---

## Using it

1. Pick a source. The trade-offs are the same as the desktop tool — MAL for the
   richest anime metadata, TVDB for real season numbering and provider ids,
   Wikipedia for English titles with directors, writers and free plots.
2. Search, then click a result to fill in the reference. Or paste an id, slug or
   URL directly.
3. Choose the output folder.
4. Set options and hit **Export NFO files**.

Options persist in `localStorage`, the same job `nfo_exporter_config.json` does
for the desktop version. The proxy URL is stored the same way.

### The recipe for a long anime series still works

Run MAL first for a rich `tvshow.nfo`, cast and poster. Then run Wikipedia over
the same folder with **Write tvshow.nfo** unchecked, which overwrites the episode
files with English titles, directors and writers and leaves the series data
alone.

---

## Limits worth knowing

- **Chromium only**, as above.
- **The page must be served over HTTPS** (or localhost). GitHub Pages is HTTPS,
  so this only bites if you self-host over plain HTTP.
- **The tab must stay open.** There is no background worker; a long
  per-episode-detail run needs the tab alive. Browsers throttle timers in
  background tabs, so a backgrounded export gets slower rather than stopping.
- **Cancel is immediate for new requests** but does not abort a page already in
  flight; it lands and is discarded.
- **Poster downloads** go through the proxy too, since the image CDNs are on the
  same blocked hosts.
