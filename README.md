# Emby NFO Exporter

A portable, stdlib-only Python tool that scrapes episode metadata and writes
Emby-compatible NFO files, split into season folders, with a `tvshow.nfo` for the
series.

Three interchangeable sources — **MyAnimeList**, **TheTVDB** and **Wikipedia** —
none of which need an API key or an account.

- [nfo_exporter.py](nfo_exporter.py) — GUI, CLI and the NFO writer
- [sources.py](sources.py) — the three data sources
- **No `pip install`** — standard library only
- **Portable** — the folder runs anywhere Python 3.9+ with tkinter exists

> **Renamed in v3.** The old single file `mal_nfo_exporter.py` is gone; the entry
> point is now `nfo_exporter.py`, and it needs `sources.py` beside it. Your saved
> settings were migrated to `nfo_exporter_config.json` automatically.

## Running it

```bash
python nfo_exporter.py
```

That opens the GUI. Pick a source, search, click a result, set the output folder,
then hit **Export NFO files**.

---

## Choosing a source

| | **mal** | **tvdb** | **wikipedia** |
| --- | --- | --- | --- |
| Series metadata | Best — synopsis, score, genres, studios, demographic, poster, trailer | Good — English overview, genres, studios, network, poster | Sparse — title and lead paragraph only |
| Real season numbering | **No** | **Yes**, plus specials as Season 00 | Yes, from article headings |
| Episode titles | English + Japanese | Origin language; English needs per-episode detail | **English + Japanese + romaji** |
| Episode plots | Sparse, **one page per episode** | Good, **one page per episode** | **Free** where the article has them — no extra requests |
| Directors / writers | No | No | **Yes** |
| Cast | **Yes**, per dub language, up to 10 languages | Yes, main voice cast | No |
| Emby provider IDs | No | **TVDB + IMDB + TMDB, filled in automatically** | No |
| Episode scores | Yes | No | No |

### Using the Wikipedia source

Wikipedia needs the **"List of &lt;show&gt; episodes"** article, not the show's main
article — a show page like `Chainsaw Man` describes the anime in prose and has no
episode table, so nothing can be read from it. Searching by show name already
biases toward the right article.

Two things the tool handles for you:

- **Very long series split their episodes across sub-articles.** `List of One
  Piece episodes` is only a navigation page. If you point at one of these, the
  error lists the actual sub-articles to use, e.g. `List of One Piece episodes
  (seasons 1–8)` (271 episodes across 8 seasons).
- **Sections for spin-offs, home media and references are skipped.** Several
  articles carry a separate spin-off further down with its own "Part 1/2/3"
  tables; folding those into the main seasons would mis-number everything.
- **Multi-segment episodes are merged.** Where one episode number covers two
  titled segments, you get a single NFO titled
  `Yor's Kitchen / The Informant's Great Romance Plan` rather than two files or a
  dropped title.
- **Episode plots come free.** Where an article includes per-episode summaries
  they're read straight out of the same page, with citation markers like `[2]`
  removed — no `--synopsis` flag and no extra requests. MAL and TVDB both need a
  separate page fetch per episode for this, so a 296-episode show is 2 requests
  here versus 300+ there.

  Coverage depends on the article, because summaries are an editorial choice:

  | Article | Episodes | Plots |
  | --- | --- | --- |
  | Hamtaro | 296 | 100% |
  | Frieren | 38 | 100% |
  | Cowboy Bebop / Death Note / Mob Psycho 100 | 26 / 37 / 37 | 100% |
  | Attack on Titan, Spy × Family, Vinland Saga | 96 / 50 / 48 | none — those articles carry no summaries |

Rules of thumb:

- **Anime, one season at a time** → `mal`. Richest metadata, and the only source
  with per-language voice actors and episode scores.
- **A whole multi-season series in one run** → `tvdb`. It also hands you the
  TVDB/IMDB/TMDB ids that make Emby match the series properly.
- **English episode titles with plots, directors and writers** → `wikipedia`.
  Where the article has summaries, this is by far the cheapest way to get episode
  plots: two requests for a whole series instead of one per episode.

They combine well. A good recipe for a long anime series:

```bash
python nfo_exporter.py --source mal --ref 16498 -o "D:\Anime" -s 1 --name "Attack on Titan" --poster
```

```bash
python nfo_exporter.py --source wikipedia --ref "List of Attack on Titan episodes" -o "D:\Anime" --name "Attack on Titan" --no-tvshow
```

The first writes a rich `tvshow.nfo` plus cast and poster; the second overwrites
the episode files with English titles, directors and writers, leaving the series
data alone.

**Check the season counts before mixing sources.** They don't always agree on
where a season ends — anime split cours are numbered differently by each site.
Frieren, for example, is 28 + 10 episodes on both TVDB and Wikipedia, but Attack
on Titan's final season is 30 episodes on TVDB and 37 on Wikipedia. Each export
logs `seasons found: …`, so compare that line between runs; if they differ,
pick one source for episodes rather than layering them.

---

## Why not the official APIs?

- **MyAnimeList API v2** exposes *no episode data at all* — no episodes
  endpoint, `fields=episodes` is silently ignored — and no characters endpoint.
  It cannot back this tool, with or without a key.
- **TheTVDB API v4** requires a paid/registered key. Its website carries the same
  data, and the one JSON endpoint its own search box uses is unauthenticated, so
  that is what the `tvdb` source calls.
- **Wikipedia's** MediaWiki API *is* open, and the `wikipedia` source uses it
  properly rather than scraping HTML pages.

**The caveat inherent to scraping:** MAL and TVDB parsing depends on their HTML
layout. If either redesigns a page, that parser needs updating. The tool fails
loudly — it raises rather than writing empty NFOs — and skips unlabelled rows
instead of inventing episode numbers.

---

## Output layout

```
<Output folder>/
└── Attack on Titan (2013)/
    ├── tvshow.nfo
    ├── folder.jpg                       (optional)
    ├── Season 00/                       (specials, tvdb only)
    │   ├── season.nfo
    │   └── Attack on Titan S00E14.nfo
    ├── Season 01/
    │   ├── season.nfo
    │   ├── Attack on Titan S01E01.nfo
    │   └── ...
    └── Season 02/
        └── ...
```

Point the export at your existing media folder (or copy the NFOs in afterwards)
so each `.nfo` sits next to its matching video file. Emby matches on
`<season>`/`<episode>`, not on filename, so exact filename matching isn't
required — but keeping them aligned makes the library easier to eyeball.

---

## Seasons

**TVDB and Wikipedia know about seasons**, so one run writes them all. That's the
default from the CLI when you don't pass `-s`, and the **All seasons** checkbox in
the GUI. Pass `-s 2` to write only season 2.

**MyAnimeList has no concept of seasons.** Every season, cour and OVA run is a
separate MAL entry, numbered from episode 1. So with `mal` it's *one entry = one
season*: export the first entry as season 1, find the sequel's entry, export it as
season 2, and so on.

### Keeping every season in one folder

Set **Show name** to the same base title on every run. An explicit show name
becomes the folder name **verbatim, with no year appended** — that's what makes
the seasons converge. Left blank, the folder is derived from that entry's own
title and year, so a 2026 season 2 would land beside a 2023 season 1 instead of
inside it.

Also turn **Write tvshow.nfo** off for seasons 2+, or the sequel's details will
overwrite your series-level data.

### Split cours — Episode number offset

Some seasons ship as two entries that both start at episode 1. Set **Episode
number offset** to `12` on the second and it writes `S01E13`–`S01E24`. The
original number is kept in `<sourceepisodenumber>`.

---

## Options

| Option | What it does |
| --- | --- |
| **Source** | `mal` / `tvdb` / `wikipedia`. Controls everything: series details, episodes and cast. |
| **All seasons** | Write every season the source provides. Ignored for `mal`, which has no seasons. |
| **Season** | Season to assign (`mal`), or the single season to write when *All seasons* is off. |
| **Prefer English titles** | Use the English title where the source has one, else the original. Japanese always goes to `<originaltitle>`. |
| **Show name** | Overrides the folder name and `<title>`, verbatim and without a year. |
| **Episode number offset** | Added to every episode number. For split cours. |
| **Provider IDs** | TVDB/TMDB/AniDB to embed. The `tvdb` source fills TVDB, IMDB and TMDB in for you. |
| **Write tvshow.nfo / season.nfo** | Turn off `tvshow.nfo` when adding to a series Emby already knows. |
| **Overwrite existing NFO files** | Off = existing files are left alone and counted as skipped. |
| **Include year in show folder name** | `Show Name (2023)` vs `Show Name`. Ignored when you set a Show name. |
| **Download poster as folder.jpg** | Where the source gives a `.webp`, the `.jpg` sibling is preferred — both exist on MAL's CDN and `folder.jpg` is safest for Emby. |
| **Include cast + language** | Up to 30 `<actor>` entries. The language picker is MAL-only; TVDB gives one main cast; Wikipedia has none. |
| **Fetch per-episode detail** | One extra page fetch **per episode**, so it's slow. On `mal` it adds plots; on **`tvdb` it also converts episode titles to English**. Only fetched for episodes that survive the season filter. |

---

## Getting Emby to match the series

Emby doesn't natively know MAL. The tool always writes the source's own id, but
it's TVDB/IMDB/TMDB that Emby actually matches on — which is the strongest
practical argument for the `tvdb` source, since it fills all three in
automatically.

Otherwise, either paste a TVDB or TMDB ID into the provider fields, or disable
metadata downloading for the library in Emby (*Library → Manage Library →
Metadata downloaders*), leaving only "Nfo" enabled so Emby trusts your files.

Then run **Scan library files**. If changes don't appear, use *Refresh metadata →
Replace all metadata* with *Search for missing metadata* off.

---

## Command line

```bash
python nfo_exporter.py --source tvdb --search "attack on titan"
```

```bash
python nfo_exporter.py --source tvdb --ref attack-on-titan -o "D:\TV" --poster
```

```bash
python nfo_exporter.py --source mal --ref 52991 -o "D:\Anime" -s 1
```

| Flag | Meaning |
| --- | --- |
| `--source {mal,tvdb,wikipedia}` | Where to get data from (default: `mal`) |
| `--ref REF` (`--id`) | MAL anime ID, TVDB slug, Wikipedia article title, or any URL of those |
| `--search TERM` | Search the source and print refs, then exit |
| `-o, --output DIR` | Output root folder |
| `-s, --season N` | Write just this season. Omit with `tvdb`/`wikipedia` to write every season |
| `--all-seasons` | Force every season |
| `--name NAME` | Override the show name (becomes the folder name verbatim) |
| `--offset N` | Add N to every episode number |
| `--japanese-titles` | Prefer the original title over English |
| `--synopsis` | Fetch per-episode detail (plots; English titles on `tvdb`) |
| `--no-tvshow` / `--no-season-nfo` | Skip those files |
| `--no-cast` | Don't include actors |
| `--cast-language LANG` | Dub language for MAL cast (default: `Japanese`) |
| `--poster` | Download the poster as `folder.jpg` |
| `--no-overwrite` | Skip files that already exist |
| `--no-year-folder` | Omit the year from the show folder name |
| `--tvdb ID` `--tmdb ID` `--anidb ID` | Provider IDs to embed |

Exit codes: `0` success, `1` failure, `2` unreadable ref, `130` cancelled.

GUI settings are remembered in `nfo_exporter_config.json` beside the script.

---

## What ends up in the files

**`tvshow.nfo`** — title, original title, sort title, plot, score as `<rating>`
plus `<criticrating>` out of 100, vote count, `<mpaa>`, premiere and end dates,
status, runtime, studios and network, genres, tags (`Anime`, demographic, airing
season), trailer, provider IDs, cast and poster.

**`season.nfo`** — season title (`Specials` for season 0), number, plot, premiere
date, year, id, poster.

**Episode NFOs** — title, original title, show title, season and episode number,
air date, plot, score, runtime, `<mpaa>`, `<director>` and `<credits>` where the
source has them, studios, and a namespaced `<uniqueid>`.

Exactly one `<uniqueid>` carries `default="true"` and each provider type appears
once — a TVDB *slug* is never written as if it were a numeric TVDB id, and the
composite episode id is namespaced (`tvdbepisode`) so Emby can't mistake it for a
real provider episode id.

Along the way: MAL's `[Written by MAL Rewrite]` footer is stripped, paragraph
breaks are kept, HTML entities are decoded, `Surname, Given` names are flipped,
`PG-13 - Teens 13 or older`-style ratings map to `TV-14`, demographics are split
out of genres into tags, thumbnail URLs are rewritten to full size, multi-person
credits become separate elements, control characters that would break XML are
removed, and folder/file names are sanitised for Windows (including reserved
names like `CON`).

---

## Politeness and reliability

MAL and TVDB are scraped at **1 request/second, 30/minute**; the Wikipedia API
gets 2/second. Everything identifies itself in its User-Agent, retries `429`/`5xx`
and connection resets with escalating backoff, and can be cancelled mid-run.

Typical cost:

| Run | Requests |
| --- | --- |
| TVDB, whole series, all seasons | 3 (series, cast, all-seasons) |
| MAL, 28-episode season | 3 (details, cast, episode list) |
| Wikipedia, whole series | 2 API calls |
| …with per-episode detail | **+1 per episode** |

Two things worth knowing:

- **Requests always ask for gzip.** These sites vary cached responses on
  `Accept-Encoding`, and Python's `urllib` sends none by default, landing on a
  much less well-cached variant. On MAL's Jikan mirror this was the difference
  between a reliable `200` and a deterministic `504`.
- **Long runs open many short-lived connections**, so occasional resets and local
  ephemeral-port exhaustion are normal; they're retried rather than fatal.

Failures are contained: a cast page that won't load produces a warning and an
otherwise complete export. A missing episode list is fatal, because that's the
payload.

---

## Requirements

- Python 3.9+ with `tkinter` (bundled with the python.org Windows installer; on
  Linux you may need `python3-tk`)
- Network access to `myanimelist.net`, `thetvdb.com`, `api4.thetvdb.com`,
  `en.wikipedia.org`, and the artwork CDNs

## Optional: standalone .exe

```bash
pip install pyinstaller && pyinstaller --onefile --windowed --name NFO-Exporter nfo_exporter.py
```

The result lands in `dist/`; the config file is read from beside the `.exe`.
