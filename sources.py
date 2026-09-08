#!/usr/bin/env python3
"""
Data sources for the MAL -> Emby NFO Exporter.

Three interchangeable sources, all keyless:

  mal        myanimelist.net       richest anime metadata; no season numbering
  tvdb       thetvdb.com           real season/episode numbering; English + original titles
  wikipedia  en.wikipedia.org      episode tables with directors, writers and ISO air dates

Every source exposes the same four calls, so the exporter does not care which
one it is talking to:

    search(term)                  -> list[SearchHit]
    show(ref)                     -> Show
    episodes(ref, ...)            -> list[episode dict]
    cast(ref, language)           -> list[actor dict]

`ref` is whatever identifies a series for that source: a MAL numeric id, a TVDB
slug, or a Wikipedia article title.

Episode dicts are uniform:
    season, number, title, title_japanese, title_romaji, aired,
    score, synopsis, url, director, writer, runtime
`season` is None when the source has no concept of seasons (MAL), in which case
the exporter assigns one.
"""

from __future__ import annotations

import gzip
import html as html_module
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass, field

APP_VERSION = "3.0"
BROWSER_UA = f"Mozilla/5.0 (compatible; mal-nfo-exporter/{APP_VERSION})"
API_UA = f"mal-nfo-exporter/{APP_VERSION} (Emby NFO generator)"

MAL_BASE = "https://myanimelist.net"
TVDB_BASE = "https://thetvdb.com"
# The only unauthenticated TVDB JSON endpoint: the one its own search box uses.
TVDB_SEARCH_URL = "https://api4.thetvdb.com/web/search/queries"
WIKI_API = "https://en.wikipedia.org/w/api.php"

SOURCES = {"mal": "MyAnimeList", "tvdb": "TheTVDB", "wikipedia": "Wikipedia"}

MAL_EPISODE_PAGE_SIZE = 100
CAST_LIMIT = 30

_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
_TAG_RE = re.compile(r"<[^>]+>")
_MAL_FOOTER = re.compile(r"\s*\[Written by MAL Rewrite\]\s*$", re.IGNORECASE)
_ILLEGAL_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")

DEMOGRAPHICS = {"shounen", "shoujo", "seinen", "josei", "kids"}


class Cancelled(Exception):
    """Raised when the user aborts a running export."""


class ScrapeError(Exception):
    """A page could not be fetched, or could not be understood."""


# --------------------------------------------------------------------------- #
# Text helpers
# --------------------------------------------------------------------------- #

def clean_text(value) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n").strip()
    text = _MAL_FOOTER.sub("", text)
    return _ILLEGAL_XML.sub("", text)


def strip_tags(fragment: str, keep_breaks: bool = False) -> str:
    """HTML fragment -> plain text, entities resolved, nbsp normalised."""
    text = fragment or ""
    if keep_breaks:
        text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
        text = re.sub(r"</p\s*>", "\n\n", text, flags=re.I)
    text = _TAG_RE.sub("", text)
    text = html_module.unescape(text).replace("\xa0", " ")
    if keep_breaks:
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
        return "\n".join(line.strip() for line in text.split("\n")).strip()
    return re.sub(r"\s+", " ", text).strip()


def flip_name(name: str) -> str:
    """'Ichinose, Kana' -> 'Kana Ichinose'. Left alone if not 'Surname, Given'."""
    name = clean_text(name)
    if name.count(",") == 1:
        last, first = (part.strip() for part in name.split(","))
        if last and first:
            return f"{first} {last}"
    return name


def parse_text_date(text: str) -> str:
    """'Jul 7, 2000' / 'April 7, 2013' -> '2000-07-07'. Partial dates -> ''."""
    text = strip_tags(text)
    iso = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", text)
    if iso:
        return iso.group(1)
    match = re.search(r"([A-Za-z]{3})[a-z.]*\s+(\d{1,2}),?\s*(\d{4})", text)
    if match:
        month = _MONTHS.get(match.group(1).lower())
        if month:
            return f"{int(match.group(3)):04d}-{month:02d}-{int(match.group(2)):02d}"
    return ""


def parse_date_range(text: str) -> tuple[str, str]:
    """'Sep 29, 2023 to Mar 22, 2024' -> ('2023-09-29', '2024-03-22')."""
    text = strip_tags(text)
    if not text or text.lower().startswith("not available"):
        return "", ""
    parts = re.split(r"\s+to\s+", text, maxsplit=1)
    return parse_text_date(parts[0]), (parse_text_date(parts[1]) if len(parts) > 1 else "")


def parse_premiered(text: str) -> tuple[str, int | None]:
    """'Fall 2023' -> ('fall', 2023)."""
    text = strip_tags(text)
    match = re.search(r"(Winter|Spring|Summer|Fall)\s+(\d{4})", text, re.I)
    if match:
        return match.group(1).lower(), int(match.group(2))
    year = re.search(r"(\d{4})", text)
    return "", int(year.group(1)) if year else None


def duration_to_seconds(text) -> int | None:
    """'24 min. per ep.' -> 1440; '1 hr. 41 min.' -> 6060; '25 minutes' -> 1500."""
    if text is None:
        return None
    if isinstance(text, int):
        return text * 60 if 0 < text < 600 else (text or None)
    lowered = strip_tags(text).lower()
    hours = re.search(r"(\d+)\s*hr", lowered)
    minutes = re.search(r"(\d+)\s*min", lowered)
    seconds = re.search(r"(\d+)\s*sec", lowered)
    total = (int(hours.group(1)) * 3600 if hours else 0) \
        + (int(minutes.group(1)) * 60 if minutes else 0) \
        + (int(seconds.group(1)) if seconds else 0)
    return total or None


def parse_int(text) -> int | None:
    if isinstance(text, int):
        return text
    digits = re.sub(r"[^\d]", "", strip_tags(text) or "")
    return int(digits) if digits else None


def normalise_status(status) -> str:
    return strip_tags(str(status or "")).replace("_", " ").strip().lower()


def rating_token(rating) -> str:
    """'PG-13 - Teens 13 or older' -> 'PG-13'. Splits on ' - ', not '-'."""
    text = strip_tags(rating)
    return re.split(r"\s+-\s+", text, maxsplit=1)[0].strip() if text else ""


def full_image_url(url: str) -> str:
    """Strip MAL's /r/<W>x<H>/ resize segment and any cache-busting query."""
    url = clean_text(url).split("?")[0]
    return re.sub(r"/r/\d+x\d+/", "/", url)


def decode_body(raw: bytes, content_encoding: str) -> str:
    """Transparently undo whatever Content-Encoding the server applied."""
    encoding = (content_encoding or "").lower()
    if "gzip" in encoding:
        raw = gzip.decompress(raw)
    elif "deflate" in encoding:
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)  # raw deflate, no zlib header
    return raw.decode("utf-8", errors="replace")


def new_episode(**values) -> dict:
    """A uniform episode record, so every source yields the same shape."""
    episode = {
        "season": None, "number": 0, "title": "", "title_japanese": "", "title_romaji": "",
        "aired": "", "score": None, "synopsis": "", "url": "",
        "director": "", "writer": "", "runtime": None,
    }
    episode.update(values)
    return episode


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #

@dataclass
class SearchHit:
    ref: str                      # what to pass back as `ref`
    title: str
    source: str = ""
    media_type: str = ""
    year: str = ""
    episode_count: int | None = None
    extra: str = ""               # score, network, ... shown in the picker

    def describe(self) -> str:
        bits = [b for b in (self.media_type, self.year,
                            f"{self.episode_count} eps" if self.episode_count else "",
                            self.extra) if b]
        return f"{self.title}  [{', '.join(bits)}]" if bits else self.title


@dataclass
class Show:
    ref: str = ""
    source: str = ""
    url: str = ""
    title: str = ""
    title_english: str = ""
    title_japanese: str = ""
    synonyms: list[str] = field(default_factory=list)
    media_type: str = ""
    source_material: str = ""
    episode_count: int | None = None
    status: str = ""
    aired_from: str = ""
    aired_to: str = ""
    duration_seconds: int | None = None
    rating_token: str = ""
    score: float | None = None
    scored_by: int | None = None
    synopsis: str = ""
    season: str = ""
    year: int | None = None
    studios: list[str] = field(default_factory=list)
    networks: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    demographics: list[str] = field(default_factory=list)
    poster: str = ""
    trailer: str = ""
    tvdb_id: str = ""
    imdb_id: str = ""
    tmdb_id: str = ""

    def display_title(self, prefer_english: bool = True) -> str:
        if prefer_english and self.title_english:
            return self.title_english
        return self.title or self.title_english or "Unknown Show"

    @property
    def display_year(self) -> str:
        return str(self.year) if self.year else (self.aired_from[:4] if self.aired_from else "")

    @property
    def runtime_minutes(self) -> str:
        try:
            value = int(self.duration_seconds)
        except (TypeError, ValueError):
            return ""
        return str(value // 60) if value >= 60 else ""


# --------------------------------------------------------------------------- #
# HTTP plumbing
# --------------------------------------------------------------------------- #

class RateLimiter:
    """Sliding-window limiter that stays responsive to cancellation."""

    def __init__(self, per_second: float, per_minute: int, cancel: threading.Event):
        self.min_gap = 1.0 / per_second
        self.per_minute = per_minute
        self.cancel = cancel
        self._stamps: list[float] = []

    def sleep(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while True:
            if self.cancel.is_set():
                raise Cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.25, remaining))

    def acquire(self) -> None:
        while True:
            if self.cancel.is_set():
                raise Cancelled()
            now = time.monotonic()
            self._stamps = [t for t in self._stamps if now - t < 60.0]
            wait = 0.0
            if self._stamps:
                wait = max(wait, self.min_gap - (now - self._stamps[-1]))
            if len(self._stamps) >= self.per_minute:
                wait = max(wait, 60.0 - (now - self._stamps[0]) + 0.05)
            if wait <= 0:
                self._stamps.append(now)
                return
            self.sleep(wait)


class WebClient:
    """
    Rate-limited, retrying, cancellable fetcher shared by every source.

    Always asks for gzip. That is not only bandwidth: these sites (and the CDNs
    in front of them) vary cached responses on Accept-Encoding, and urllib sends
    none by default, which lands on a far less well-cached variant.
    """

    per_second = 1.0
    per_minute = 30
    user_agent = BROWSER_UA
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

    def __init__(self, cancel: threading.Event | None = None, log=None):
        self.cancel = cancel or threading.Event()
        self.log = log or (lambda message: None)
        self.limiter = RateLimiter(self.per_second, self.per_minute, self.cancel)

    def headers(self) -> dict:
        return {
            "User-Agent": self.user_agent,
            "Accept": self.accept,
            "Accept-Encoding": "gzip, deflate",
            "Accept-Language": "en-US,en;q=0.9",
        }

    def request(self, url: str, data: bytes | None = None, content_type: str = "",
                retries: int = 4) -> str:
        # Scraping opens a fresh connection per page, so on long runs transient
        # resets and local ephemeral-port exhaustion do happen. Be patient.
        head = self.headers()
        if content_type:
            head["Content-Type"] = content_type
        last_error = "unknown error"
        for attempt in range(1, retries + 1):
            self.limiter.acquire()
            req = urllib.request.Request(url, headers=head, data=data)
            try:
                with urllib.request.urlopen(req, timeout=45) as response:
                    return decode_body(response.read(), response.headers.get("Content-Encoding"))
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    raise ScrapeError(f"Not found: {url}") from exc
                if exc.code in (401, 403):
                    raise ScrapeError(f"Refused (HTTP {exc.code}): {url}") from exc
                last_error = f"HTTP {exc.code}"
                retryable = exc.code == 429 or exc.code >= 500
            except urllib.error.URLError as exc:
                last_error = f"network error: {exc.reason}"
                retryable = True
            except (TimeoutError, zlib.error, EOFError, OSError) as exc:
                last_error = f"bad response: {exc}"
                retryable = True
            if not retryable or attempt == retries:
                break
            backoff = min(2.5 * attempt, 15.0)
            self.log(f"  {last_error} - retrying in {backoff:.0f}s ({attempt}/{retries - 1})")
            self.limiter.sleep(backoff)
        raise ScrapeError(f"{last_error} for {url}")

    def get(self, url: str, retries: int = 4) -> str:
        return self.request(url, retries=retries)

    def get_json(self, url: str, retries: int = 4):
        try:
            return json.loads(self.get(url, retries=retries))
        except json.JSONDecodeError as exc:
            raise ScrapeError(f"Bad JSON from {url}: {exc}") from exc

    def post_json(self, url: str, payload: dict, retries: int = 3):
        body = self.request(url, data=json.dumps(payload).encode("utf-8"),
                            content_type="application/json", retries=retries)
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise ScrapeError(f"Bad JSON from {url}: {exc}") from exc

    def download(self, url: str, path) -> None:
        if self.cancel.is_set():
            raise Cancelled()
        self.limiter.acquire()
        req = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
        with urllib.request.urlopen(req, timeout=60) as response:
            data = response.read()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


# --------------------------------------------------------------------------- #
# MyAnimeList
# --------------------------------------------------------------------------- #

def mal_sidebar_fragment(doc: str, *labels: str) -> str:
    """One sidebar field's raw HTML, scoped so it cannot bleed into the next."""
    for label in labels:
        pattern = (r'<span class="dark_text">\s*' + re.escape(label)
                   + r':\s*</span>(.*?)(?=<span class="dark_text">|</div>)')
        match = re.search(pattern, doc, re.S)
        if match:
            return match.group(1)
    return ""


def mal_sidebar_text(doc: str, *labels: str) -> str:
    return strip_tags(mal_sidebar_fragment(doc, *labels))


def mal_sidebar_links(doc: str, *labels: str) -> list[str]:
    fragment = mal_sidebar_fragment(doc, *labels)
    names, seen = [], set()
    for raw in re.findall(r"<a\b[^>]*>(.*?)</a>", fragment, re.S):
        name = strip_tags(raw)
        if name and name.lower() not in seen and name.lower() != "add some":
            seen.add(name.lower())
            names.append(name)
    return names


_MAL_ROW_RE = re.compile(r'<tr class="episode-list-data">(.*?)</tr>', re.S)
_MAL_NUM_RE = re.compile(r'class="episode-number[^"]*"[^>]*data-raw="(\d+)"')
_MAL_LINK_RE = re.compile(r'class="episode-title[^"]*">\s*<a\s+href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_MAL_ALT_RE = re.compile(r'<span class="di-ib">(.*?)</span>', re.S)
_MAL_AIRED_RE = re.compile(r'class="episode-aired[^"]*">([^<]*)<')
# Anchored to episode-poll: episode-forum carries a data-raw reply count too.
_MAL_SCORE_RE = re.compile(r'class="episode-poll[^"]*"[^>]*data-raw="([\d.]+)"')
_MAL_OFFSET_RE = re.compile(r"\?offset=(\d+)")


def split_alt_title(text: str) -> tuple[str, str]:
    """MAL's secondary title cell reads 'Romaji (Japanese)'."""
    text = strip_tags(text)
    if not text:
        return "", ""
    match = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", text, re.S)
    if match and match.group(2).strip():
        return match.group(1).strip(), match.group(2).strip()
    return text, ""


def parse_mal_episode_rows(doc: str, ref: str) -> list[dict]:
    episodes = []
    for index, block in enumerate(_MAL_ROW_RE.findall(doc), start=1):
        number = _MAL_NUM_RE.search(block)
        link = _MAL_LINK_RE.search(block)
        aired = _MAL_AIRED_RE.search(block)
        score = _MAL_SCORE_RE.search(block)
        alt = _MAL_ALT_RE.search(block)
        romaji, japanese = split_alt_title(alt.group(1) if alt else "")
        episodes.append(new_episode(
            number=int(number.group(1)) if number else index,
            url=strip_tags(link.group(1)) if link else f"{MAL_BASE}/anime/{ref}",
            title=strip_tags(link.group(2)) if link else "",
            title_japanese=japanese,
            title_romaji=romaji,
            aired=parse_text_date(aired.group(1)) if aired else "",
            score=float(score.group(1)) if score else None,
        ))
    return episodes


def parse_mal_characters(doc: str, language: str) -> list[dict]:
    """
    Flatten MAL's character table into actor rows for one dub language.
    Falls back to the Japanese cast when the requested language is absent.
    """
    rows = []
    for block in re.split(r'class="js-anime-character-table"', doc)[1:]:
        name_match = re.search(r'<h3 class="h3_character_name">(.*?)</h3>', block, re.S)
        if not name_match:
            continue
        char_name = strip_tags(name_match.group(1))
        if not char_name:
            continue
        fav_match = (re.search(r'class="js-anime-character-favorites"[^>]*>\s*([\d,]+)', block)
                     or re.search(r"([\d,]+)\s+Favorites", block))
        favourites = parse_int(fav_match.group(1)) if fav_match else 0
        is_main = bool(re.search(r'<div class="spaceit_pad">\s*Main', block))

        va_area = block.split('class="js-anime-character-va"')
        candidates = []
        if len(va_area) > 1:
            for va_row in re.split(r'class="js-anime-character-va-lang"', va_area[1])[1:]:
                person = re.search(r'href="[^"]*/people/\d+/[^"]*"[^>]*>(.*?)</a>', va_row, re.S)
                if not person:
                    continue
                lang = re.search(r'js-anime-character-language"[^>]*>\s*([^<]+)', va_row)
                thumb = re.search(r'data-src="([^"]*voiceactors[^"]*)"', va_row)
                candidates.append({
                    "name": flip_name(strip_tags(person.group(1))),
                    "language": strip_tags(lang.group(1)) if lang else "",
                    "thumb": full_image_url(thumb.group(1)) if thumb else "",
                })
        if not candidates:
            continue
        picked = next((c for c in candidates if c["language"] == language), None)
        if picked is None and language != "Japanese":
            picked = next((c for c in candidates if c["language"] == "Japanese"), None)
        if picked is None or not picked["name"]:
            continue
        rows.append({"name": picked["name"], "role": char_name, "thumb": picked["thumb"],
                     "favorites": favourites or 0, "main": is_main})
    rows.sort(key=lambda r: (not r["main"], -r["favorites"], r["name"]))
    return rows[:CAST_LIMIT]


def parse_mal_episode_synopsis(doc: str) -> str:
    match = re.search(r"<h2[^>]*>\s*Synopsis\s*</h2>(.*?)(?:</div>|<h2)", doc, re.S)
    if not match:
        return ""
    text = strip_tags(match.group(1), keep_breaks=True)
    if re.match(r"^no synopsis", text, re.I):
        return ""
    return text


class MalSource(WebClient):
    """myanimelist.net. Richest anime metadata, but no season numbering."""

    key = "mal"
    label = "MyAnimeList"
    has_seasons = False
    ref_hint = "MAL anime ID or myanimelist.net URL"

    @staticmethod
    def parse_ref(text: str) -> str:
        text = (text or "").strip()
        if text.isdigit():
            return text
        match = re.search(r"myanimelist\.net/anime/(\d+)", text, re.I)
        return match.group(1) if match else ""

    def search(self, term: str, limit: int = 20) -> list[SearchHit]:
        doc = self.get(f"{MAL_BASE}/anime.php?"
                       + urllib.parse.urlencode({"q": term, "cat": "anime"}))
        hits, seen = [], set()
        for block in re.split(r"<tr>", doc)[1:]:
            link = re.search(r'href="https://myanimelist\.net/anime/(\d+)/[^"]*"', block)
            if not link:
                continue
            ref = link.group(1)
            if ref in seen:
                continue
            title_match = (re.search(r'class="hoverinfo_trigger[^"]*"[^>]*>\s*<strong>(.*?)</strong>',
                                     block, re.S)
                           or re.search(r"<strong>(.*?)</strong>", block, re.S))
            if not title_match:
                continue
            cells = [strip_tags(c) for c in re.findall(
                r'<td[^>]*class="borderClass ac bgColor\d"[^>]*>(.*?)</td>', block, re.S)]
            seen.add(ref)
            score = cells[2] if len(cells) > 2 else ""
            hits.append(SearchHit(
                ref=ref, title=strip_tags(title_match.group(1)), source=self.key,
                media_type=(cells[0] if cells else "").upper(),
                episode_count=parse_int(cells[1]) if len(cells) > 1 else None,
                extra=f"score {score}" if score and score != "N/A" else "",
            ))
            if len(hits) >= limit:
                break
        return hits

    def show(self, ref: str) -> Show:
        doc = self.get(f"{MAL_BASE}/anime/{ref}")
        title_match = (re.search(r'<h1[^>]*class="title-name[^"]*"[^>]*>(.*?)</h1>', doc, re.S)
                       or re.search(r'<meta property="og:title" content="([^"]*)"', doc))
        title = strip_tags(title_match.group(1)) if title_match else ""
        if not title:
            raise ScrapeError(f"Could not read a title from MAL's page for anime {ref}. "
                              "MAL may have changed its layout.")

        english = mal_sidebar_text(doc, "English")
        if not english:
            match = re.search(r'<p class="title-english[^"]*">(.*?)</p>', doc, re.S)
            english = strip_tags(match.group(1)) if match else ""

        aired_from, aired_to = parse_date_range(mal_sidebar_text(doc, "Aired"))
        season, year = parse_premiered(mal_sidebar_text(doc, "Premiered"))
        if year is None and aired_from:
            year = int(aired_from[:4])

        synopsis_match = re.search(r'<p itemprop="description">(.*?)</p>', doc, re.S)
        synopsis = clean_text(strip_tags(synopsis_match.group(1), keep_breaks=True)) \
            if synopsis_match else ""

        score_match = re.search(r'itemprop="ratingValue"[^>]*>([^<]*)<', doc)
        count_match = re.search(r'itemprop="ratingCount"[^>]*>([^<]*)<', doc)
        try:
            score = float(strip_tags(score_match.group(1))) if score_match else None
        except ValueError:
            score = None

        poster = ""
        for tag in re.findall(r"<img\b[^>]*>", doc):
            if 'itemprop="image"' in tag:
                src = re.search(r'data-src="([^"]+)"', tag) or re.search(r'src="([^"]+)"', tag)
                if src:
                    poster = full_image_url(src.group(1))
                break

        trailer = ""
        # MAL embeds PVs via youtube-nocookie.com; normalise to a watch URL.
        trailer_match = re.search(r"youtube(?:-nocookie)?\.com/embed/([A-Za-z0-9_-]{6,})", doc)
        if trailer_match:
            trailer = f"https://www.youtube.com/watch?v={trailer_match.group(1)}"

        return Show(
            ref=str(ref), source=self.key, url=f"{MAL_BASE}/anime/{ref}",
            title=title, title_english=english,
            title_japanese=mal_sidebar_text(doc, "Japanese"),
            synonyms=[s.strip() for s in mal_sidebar_text(doc, "Synonyms").split(",") if s.strip()],
            media_type=mal_sidebar_text(doc, "Type").upper(),
            source_material=mal_sidebar_text(doc, "Source"),
            episode_count=parse_int(mal_sidebar_text(doc, "Episodes")),
            status=normalise_status(mal_sidebar_text(doc, "Status")),
            aired_from=aired_from, aired_to=aired_to,
            duration_seconds=duration_to_seconds(mal_sidebar_text(doc, "Duration")),
            rating_token=rating_token(mal_sidebar_text(doc, "Rating")),
            score=score,
            scored_by=parse_int(count_match.group(1)) if count_match else None,
            synopsis=synopsis, season=season, year=year,
            studios=mal_sidebar_links(doc, "Studios", "Studio"),
            networks=[],
            genres=mal_sidebar_links(doc, "Genres", "Genre")
            + mal_sidebar_links(doc, "Themes", "Theme"),
            demographics=mal_sidebar_links(doc, "Demographics", "Demographic"),
            poster=poster, trailer=trailer,
        )

    def episodes(self, ref: str, on_page=None) -> list[dict]:
        episodes: list[dict] = []
        seen: set[int] = set()
        offset = 0
        last_page = None
        while True:
            if self.cancel.is_set():
                raise Cancelled()
            doc = self.get(f"{MAL_BASE}/anime/{ref}/_/episode?offset={offset}")
            rows = parse_mal_episode_rows(doc, ref)
            fresh = [r for r in rows if r["number"] not in seen]
            for row in fresh:
                seen.add(row["number"])
            episodes.extend(fresh)

            if last_page is None:
                offsets = [int(v) for v in _MAL_OFFSET_RE.findall(doc)]
                last_page = (max(offsets) if offsets else 0) // MAL_EPISODE_PAGE_SIZE + 1
            page = offset // MAL_EPISODE_PAGE_SIZE + 1
            if on_page:
                on_page(page, max(last_page, page), len(episodes))

            if not fresh or len(rows) < MAL_EPISODE_PAGE_SIZE:
                break
            offset += MAL_EPISODE_PAGE_SIZE
            if offset > 20000:  # ~20k episodes; guard against a pagination loop
                break
        episodes.sort(key=lambda row: row["number"])
        return episodes

    def fetch_detail(self, ref: str, episode: dict) -> None:
        """Pull this episode's plot from its own MAL page."""
        try:
            doc = self.get(f"{MAL_BASE}/anime/{ref}/_/episode/{episode['number']}", retries=2)
        except ScrapeError:
            return
        synopsis = parse_mal_episode_synopsis(doc)
        if synopsis:
            episode["synopsis"] = synopsis

    def cast(self, ref: str, language: str = "Japanese") -> list[dict]:
        try:
            return parse_mal_characters(self.get(f"{MAL_BASE}/anime/{ref}/_/characters"), language)
        except ScrapeError:
            return []


# --------------------------------------------------------------------------- #
# TheTVDB
# --------------------------------------------------------------------------- #

def tvdb_translation(doc: str, language: str = "eng") -> tuple[str, str]:
    """
    TVDB hides every translation in the page as
      <div class="change_translation_text" data-language="eng" data-title="..."><p>overview</p></div>
    Anonymous visitors are shown the series' origin language, so for anime the
    visible title is Japanese and the English one has to be lifted out of here.
    """
    pattern = (r'data-language="' + re.escape(language)
               + r'"\s+data-title="([^"]*)"[^>]*>\s*(?:<p>(.*?)</p>)?')
    match = re.search(pattern, doc, re.S)
    if not match:
        return "", ""
    return (strip_tags(match.group(1)),
            strip_tags(match.group(2) or "", keep_breaks=True))


def tvdb_info_field(doc: str, label: str) -> str:
    """One <li> of the series sidebar, as raw HTML."""
    block = re.search(r'id="series_basic_info"(.*)', doc, re.S)
    scope = block.group(1)[:20000] if block else doc
    match = re.search(r"<li[^>]*>\s*<strong>\s*" + re.escape(label)
                      + r"\s*</strong>(.*?)</li>", scope, re.S)
    return match.group(1) if match else ""


def tvdb_info_text(doc: str, label: str) -> str:
    return strip_tags(tvdb_info_field(doc, label))


def tvdb_info_links(doc: str, label: str) -> list[str]:
    fragment = tvdb_info_field(doc, label)
    names, seen = [], set()
    for raw in re.findall(r"<a\b[^>]*>(.*?)</a>", fragment, re.S):
        name = strip_tags(raw)
        if name and name.lower() not in seen:
            seen.add(name.lower())
            names.append(name)
    if not names:
        text = strip_tags(fragment)
        return [text] if text else []
    return names


def parse_tvdb_episode_label(item: str) -> tuple[int, int] | None:
    """
    Numbered episodes are labelled 'S04E12'; the 'Additional Specials' block uses
    'SPECIAL 0x14' instead. Specials map to season 0, which is what Emby expects.
    """
    normal = re.search(r'episode-label">\s*S(\d+)E(\d+)\s*<', item)
    if normal:
        return int(normal.group(1)), int(normal.group(2))
    special = re.search(r'episode-label">\s*SPECIAL\s+(\d+)x(\d+)\s*<', item, re.I)
    if special:
        return int(special.group(1)), int(special.group(2))
    return None


def parse_tvdb_allseasons(doc: str) -> list[dict]:
    """
    TVDB's /allseasons/official page: an <h3> per season, then a <ul> of
    list-group-item episodes. One request covers every season plus specials.
    """
    episodes: list[dict] = []
    # Split on the season headings so each chunk has a known fallback season.
    chunks = re.split(r'<h3[^>]*>\s*<a href="[^"]*/seasons/official/(\d+)"[^>]*>', doc)
    for i in range(1, len(chunks) - 1, 2):
        fallback_season = int(chunks[i])
        body = chunks[i + 1]
        # Prefix match, not an exact class: specials carry extra classes.
        for item in re.split(r'<li class="list-group-item', body)[1:]:
            link = re.search(r'<a href="([^"]*/episodes/(\d+))"[^>]*>\s*(.*?)\s*</a>', item, re.S)
            if not link:
                continue
            label = parse_tvdb_episode_label(item)
            if label is None:
                # No S/E label at all: skip rather than invent a number.
                continue
            season, number = label
            meta = re.search(r'<ul class="list-inline text-muted">(.*?)</ul>', item, re.S)
            aired = ""
            if meta:
                first = re.search(r"<li>(.*?)</li>", meta.group(1), re.S)
                aired = parse_text_date(first.group(1)) if first else ""
            overview = re.search(r'<div class="col-xs-9">\s*<p>(.*?)</p>', item, re.S)
            episodes.append(new_episode(
                season=season if season is not None else fallback_season,
                number=number,
                title=strip_tags(link.group(3)),
                aired=aired,
                url=f"{TVDB_BASE}{link.group(1)}" if link.group(1).startswith("/") else link.group(1),
                synopsis=strip_tags(overview.group(1), keep_breaks=True) if overview else "",
            ))
    return episodes


def parse_tvdb_cast(doc: str) -> list[dict]:
    """TVDB series page: the actor tab holds <h3>Name<br><small>as Role</small></h3>."""
    # Bound on the next people-* tab (crew, guest stars) rather than trying to
    # count closing divs -- div nesting here is not something to match on.
    block = re.search(r'id="people-actor"(.*?)(?=id="people-|\Z)', doc, re.S)
    scope = block.group(1) if block else ""
    rows = []
    for item in re.split(r'<div class="thumbnail">', scope)[1:]:
        heading = re.search(r"<h3>\s*(.*?)\s*</h3>", item, re.S)
        if not heading:
            continue
        inner = heading.group(1)
        name = strip_tags(re.split(r"<br\s*/?>", inner)[0])
        role_match = re.search(r"<small>\s*(?:as\s+)?(.*?)\s*</small>", inner, re.S)
        role = strip_tags(role_match.group(1)) if role_match else ""
        thumb = re.search(r'data-src="([^"]+)"', item)
        if not name:
            continue
        rows.append({"name": name, "role": role, "thumb": thumb.group(1) if thumb else "",
                     "favorites": 0, "main": False})
        if len(rows) >= CAST_LIMIT:
            break
    return rows


class TvdbSource(WebClient):
    """
    thetvdb.com. Real season/episode numbering -- the thing MAL cannot give.

    Search uses the one unauthenticated JSON endpoint TVDB's own search box
    calls; everything else is scraped, because the v4 API needs a key.
    """

    key = "tvdb"
    label = "TheTVDB"
    has_seasons = True
    ref_hint = "TVDB slug or thetvdb.com/series/... URL"

    @staticmethod
    def parse_ref(text: str) -> str:
        text = (text or "").strip()
        match = re.search(r"thetvdb\.com/series/([^/?#]+)", text, re.I)
        if match:
            return match.group(1)
        if text and not text.startswith("http") and "/" not in text:
            return text
        return ""

    def search(self, term: str, limit: int = 20) -> list[SearchHit]:
        payload = {"requests": [{"indexName": "TVDB", "params": {"query": term}}]}
        data = self.post_json(TVDB_SEARCH_URL, payload)
        results = (data or {}).get("results") or []
        raw_hits = results[0].get("hits", []) if results else []
        series = [h for h in raw_hits if (h.get("type") or "") == "series"]
        # Relevance puts movies and lists first; popularity is a better guide.
        series.sort(key=lambda h: -(h.get("follower_count") or 0))
        hits = []
        for hit in series[:limit]:
            ref = hit.get("slug") or str(hit.get("tvdb_id") or hit.get("id") or "")
            if not ref:
                continue
            name = strip_tags(hit.get("name") or "")
            english = ((hit.get("translations") or {}) or {}).get("eng")
            if english and hit.get("primary_language") != "eng":
                name = strip_tags(english)
            network = strip_tags(hit.get("network") or "")
            hits.append(SearchHit(
                ref=ref, title=name or ref, source=self.key, media_type="SERIES",
                year=str(hit.get("year") or ""), extra=network,
            ))
        return hits

    def show(self, ref: str) -> Show:
        doc = self.get(f"{TVDB_BASE}/series/{urllib.parse.quote(ref)}")
        english_title, english_overview = tvdb_translation(doc, "eng")
        visible = re.search(r'<h1[^>]*class="translated_title[^"]*"[^>]*>(.*?)</h1>', doc, re.S) \
            or re.search(r"<h1[^>]*>(.*?)</h1>", doc, re.S)
        original = strip_tags(visible.group(1)) if visible else ""
        if not (original or english_title):
            raise ScrapeError(f"Could not read a title from TVDB's page for '{ref}'.")

        _, japanese_overview = tvdb_translation(doc, "jpn")
        japanese_title, _ = tvdb_translation(doc, "jpn")

        first_aired = parse_text_date(tvdb_info_text(doc, "First Aired"))
        recent = parse_text_date(tvdb_info_text(doc, "Recent"))
        status = normalise_status(tvdb_info_text(doc, "Status"))

        genres = [g for g in tvdb_info_links(doc, "Genres") if g.lower() != "anime"]
        demographics = [g for g in genres if g.lower() in DEMOGRAPHICS]
        genres = [g for g in genres if g.lower() not in DEMOGRAPHICS]

        poster = ""
        # Two artwork layouts are in the wild: legacy /banners/posters/<id>-N.jpg
        # and v4 /banners/v4/series/<id>/posters/<hash>.jpg. Anchoring on
        # "posters" (not "actor/photo") keeps cast headshots out of this.
        poster_match = re.search(
            r'(https://artworks\.thetvdb\.com/banners/(?:v4/series/\d+/)?'
            r'(?:posters|series)/[^"\s]+)', doc)
        if poster_match:
            poster = poster_match.group(1)

        tvdb_id = parse_int(tvdb_info_text(doc, "TheTVDB.com Series ID"))
        imdb = re.search(r'href="https?://(?:www\.)?imdb\.com/title/(tt\d+)', doc)
        tmdb = re.search(r'href="https?://(?:www\.)?themoviedb\.org/tv/(\d+)', doc)

        return Show(
            ref=str(ref), source=self.key, url=f"{TVDB_BASE}/series/{ref}",
            title=original or english_title,
            title_english=english_title,
            title_japanese=japanese_title if japanese_title != english_title else "",
            media_type="TV",
            episode_count=None,
            status=status,
            aired_from=first_aired,
            aired_to=recent if status == "ended" else "",
            duration_seconds=duration_to_seconds(tvdb_info_text(doc, "Average Runtime")),
            rating_token="",
            synopsis=english_overview or japanese_overview,
            year=int(first_aired[:4]) if first_aired else None,
            studios=tvdb_info_links(doc, "Studio") or tvdb_info_links(doc, "Production Company"),
            networks=tvdb_info_links(doc, "Network"),
            genres=genres, demographics=demographics,
            poster=poster,
            tvdb_id=str(tvdb_id) if tvdb_id else "",
            imdb_id=imdb.group(1) if imdb else "",
            tmdb_id=tmdb.group(1) if tmdb else "",
        )

    def episodes(self, ref: str, on_page=None) -> list[dict]:
        doc = self.get(f"{TVDB_BASE}/series/{urllib.parse.quote(ref)}/allseasons/official")
        episodes = parse_tvdb_allseasons(doc)
        if on_page:
            on_page(1, 1, len(episodes))
        episodes.sort(key=lambda e: (e["season"] if e["season"] is not None else 0, e["number"]))
        return episodes

    def fetch_detail(self, ref: str, episode: dict) -> None:
        """
        TVDB shows anonymous visitors the origin-language title, so this is where
        English titles come from, not just the English overview. The original
        title is kept as originaltitle rather than thrown away.
        """
        if not episode.get("url"):
            return
        try:
            title, overview = tvdb_translation(self.get(episode["url"], retries=2), "eng")
        except ScrapeError:
            return
        if title:
            if episode.get("title") and episode["title"] != title \
                    and not episode.get("title_japanese"):
                episode["title_japanese"] = episode["title"]
            episode["title"] = title
        if overview:
            episode["synopsis"] = overview

    def cast(self, ref: str, language: str = "Japanese") -> list[dict]:
        try:
            return parse_tvdb_cast(self.get(f"{TVDB_BASE}/series/{urllib.parse.quote(ref)}"))
        except ScrapeError:
            return []


# --------------------------------------------------------------------------- #
# Wikipedia
# --------------------------------------------------------------------------- #

def wiki_summary(row_html: str) -> str:
    """
    Pull the plot out of an episode's summary row:
      <tr class="expand-child"><td class="description">
        <div class="shortSummaryText">...</div>
    Citation superscripts are dropped so plots do not read '...Oxnard.[2] Both...'.
    """
    match = (re.search(r'class="description"[^>]*>(.*?)</td>', row_html, re.S)
             or re.search(r'class="shortSummaryText"[^>]*>(.*)', row_html, re.S))
    if not match:
        return ""
    fragment = re.sub(r"<sup\b[^>]*>.*?</sup>", "", match.group(1), flags=re.S | re.I)
    text = strip_tags(fragment, keep_breaks=True)
    return re.sub(r"\s*\[\d+\]", "", text).strip()


def wiki_people(fragment: str) -> str:
    """
    Wikipedia stacks multiple credits with <br>, and cells often already end in a
    comma. Split on commas, drop the blanks, rejoin cleanly.
    """
    text = strip_tags(re.sub(r"<br\s*/?>", ",", fragment or "", flags=re.I))
    parts = [p.strip() for p in text.split(",")]
    return ", ".join(p for p in parts if p)


def parse_wiki_episode_tables(html: str) -> list[dict]:
    """
    Wikipedia episode lists use Template:Episode list, which renders rows as
    <tr class="vevent module-episode-list-row">. Columns vary between articles,
    so the header row is read first and cells are mapped by header name rather
    than by position.
    """
    episodes: list[dict] = []
    # Season number comes from the h3 heading that precedes each table. The h2
    # level matters too: these articles often carry a *different* work further
    # down (a spin-off ONA with its own "Part 1/2/3" tables) plus Home media and
    # References sections. Merging those into the main series' seasons would
    # silently mis-number episodes, so only episode-ish h2 sections are read.
    pieces = re.split(r"(<h[23][^>]*>.*?</h[23]>)", html, flags=re.S)
    current_season = None
    fallback_season = 0
    section_ok = True
    for piece in pieces:
        heading = re.match(r"<h([23])[^>]*>(.*?)</h[23]>", piece, re.S)
        if heading:
            level, text = heading.group(1), strip_tags(heading.group(2))
            if level == "2":
                section_ok = bool(re.search(r"episode|season|series overview", text, re.I))
                current_season = None
                fallback_season = 0
            match = re.search(r"(?:season|series|part|cour)\s+(\d+)", text, re.I)
            current_season = int(match.group(1)) if match else None
            continue
        if not section_ok:
            continue
        for table in re.findall(r"<table[^>]*>(.*?)</table>", piece, re.S):
            if "module-episode-list-row" not in table:
                continue
            headers = [strip_tags(h).lower() for h in
                       re.findall(r"<th[^>]*scope=\"col\"[^>]*>(.*?)</th>", table, re.S)]
            season = current_season
            if season is None:
                fallback_season += 1
                season = fallback_season
            else:
                fallback_season = season
            previous: dict | None = None
            # Walk rows in document order: each episode's plot lives in the
            # <tr class="expand-child"> that follows its <tr class="vevent"> row.
            for row_class, row in re.findall(
                    r'<tr class="([^"]*)"[^>]*>(.*?)</tr>', table, re.S):
                if "expand-child" in row_class:
                    summary = wiki_summary(row)
                    if previous is not None and summary:
                        previous["synopsis"] = (
                            f"{previous['synopsis']}\n\n{summary}"
                            if previous["synopsis"] else summary)
                    continue
                if "vevent" not in row_class:
                    continue
                cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)
                if not cells:
                    continue
                get = {}
                for name, cell in zip(headers, cells):
                    get[name] = cell

                def pick(*needles):
                    for needle in needles:
                        for name, cell in get.items():
                            if needle in name:
                                return cell
                    return ""

                summary = re.search(r'<t[hd][^>]*class="[^"]*summary[^"]*"[^>]*>(.*?)</t[hd]>',
                                    row, re.S)
                title_cell = summary.group(1) if summary else pick("title")
                title = strip_tags(re.split(r"<br\s*/?>", title_cell)[0]).strip().strip('"“”')
                japanese = re.search(r'<span lang="ja">(.*?)</span>', title_cell, re.S)
                romaji = re.search(r'lang="ja-Latn"[^>]*>(.*?)</span>', title_cell, re.S)

                iso = re.search(r'class="[^"]*dtstart[^"]*">\s*(\d{4}-\d{2}-\d{2})', row)
                aired = iso.group(1) if iso else parse_text_date(pick("original air date",
                                                                     "air date", "released"))
                in_season = parse_int(pick("no. in season", "no. inseason", "no.inseason"))
                overall = parse_int(cells[0])
                number = in_season if in_season is not None else overall
                japanese_title = strip_tags(japanese.group(1)) if japanese else ""

                if number is None:
                    # A row with no number cell is a continuation: the number and
                    # air date above carry rowspan="2" because one episode holds
                    # two titled segments. Fold the extra title into that episode
                    # instead of dropping it or inventing a new episode.
                    if previous is not None and title:
                        previous["title"] = f"{previous['title']} / {title}" \
                            if previous["title"] else title
                        if japanese_title:
                            previous["title_japanese"] = (
                                f"{previous['title_japanese']} / {japanese_title}"
                                if previous["title_japanese"] else japanese_title)
                    continue

                previous = new_episode(
                    season=season, number=number,
                    title=title,
                    title_japanese=japanese_title,
                    title_romaji=strip_tags(romaji.group(1)) if romaji else "",
                    aired=aired,
                    director=wiki_people(pick("directed by", "director")),
                    writer=wiki_people(pick("written by", "writer", "storyboarded by")),
                )
                episodes.append(previous)
    return episodes


class WikipediaSource(WebClient):
    """
    en.wikipedia.org episode lists. Adds directors and writers, and carries
    machine-readable ISO air dates. Has little series-level metadata, so the
    show details it returns are deliberately sparse.
    """

    key = "wikipedia"
    label = "Wikipedia"
    has_seasons = True
    # Wikipedia throttles bursts from anonymous clients with 429s well before its
    # documented ceiling, and a whole series needs only two calls, so go slowly.
    per_second = 1.0
    per_minute = 20
    user_agent = API_UA
    ref_hint = "Wikipedia article title or en.wikipedia.org URL"

    @staticmethod
    def parse_ref(text: str) -> str:
        text = (text or "").strip()
        match = re.search(r"en\.wikipedia\.org/wiki/([^?#]+)", text, re.I)
        if match:
            return urllib.parse.unquote(match.group(1)).replace("_", " ")
        return text if text and not text.startswith("http") else ""

    def api(self, params: dict):
        # retries=6: a 429 here is a throttle that clears, not a dead end.
        return self.get_json(f"{WIKI_API}?" + urllib.parse.urlencode(
            {"format": "json", "formatversion": 2, **params}), retries=6)

    def search(self, term: str, limit: int = 20) -> list[SearchHit]:
        # Bias toward the article that actually holds an episode table.
        query = term if re.search(r"episode", term, re.I) else f"List of {term} episodes"
        data = self.api({"action": "query", "list": "search", "srsearch": query,
                         "srlimit": max(limit, 10), "srnamespace": 0})
        results = ((data or {}).get("query") or {}).get("search") or []
        hits = []
        for row in results[:limit]:
            title = row.get("title") or ""
            if not title:
                continue
            hits.append(SearchHit(
                ref=title, title=title, source=self.key,
                media_type="ARTICLE",
                extra="episode list" if re.search(r"episode", title, re.I) else "",
            ))
        # Episode-list articles first: those are the ones that parse.
        hits.sort(key=lambda h: (0 if h.extra else 1))
        return hits

    def page_html(self, ref: str) -> str:
        data = self.api({"action": "parse", "page": ref, "prop": "text", "redirects": 1})
        if "error" in (data or {}):
            raise ScrapeError(f"Wikipedia: {data['error'].get('info', 'article not found')}")
        text = ((data or {}).get("parse") or {}).get("text") or ""
        if not text:
            raise ScrapeError(f"Wikipedia returned no content for '{ref}'.")
        return text

    def show(self, ref: str) -> Show:
        html = self.page_html(ref)
        title = re.sub(r"^List of\s+", "", ref, flags=re.I)
        title = re.sub(r"\s+episodes$", "", title, flags=re.I).strip()
        lead = ""
        for para in re.findall(r"<p>(.*?)</p>", html, re.S):
            text = strip_tags(para, keep_breaks=True)
            if len(text) > 120:
                lead = text
                break
        episodes = parse_wiki_episode_tables(html)
        dates = sorted(e["aired"] for e in episodes if e["aired"])
        return Show(
            ref=ref, source=self.key,
            url=f"https://en.wikipedia.org/wiki/{urllib.parse.quote(ref.replace(' ', '_'))}",
            title=title, title_english=title,
            media_type="TV",
            episode_count=len(episodes) or None,
            aired_from=dates[0] if dates else "",
            aired_to=dates[-1] if dates else "",
            synopsis=lead,
            year=int(dates[0][:4]) if dates else None,
        )

    def episodes(self, ref: str, on_page=None) -> list[dict]:
        html = self.page_html(ref)
        episodes = parse_wiki_episode_tables(html)
        if not episodes:
            raise ScrapeError(self.explain_empty(ref, html))
        if on_page:
            on_page(1, 1, len(episodes))
        episodes.sort(key=lambda e: (e["season"] or 0, e["number"]))
        return episodes

    @staticmethod
    def sub_articles(html: str) -> list[str]:
        """Linked 'List of ... episodes (season N)' style articles."""
        found, seen = [], set()
        for href, text in re.findall(r'<a href="/wiki/([^"#]+)"[^>]*>([^<]*)</a>', html):
            title = urllib.parse.unquote(href).replace("_", " ")
            if re.search(r"^List of .* episodes\s*\(", title, re.I) and title not in seen:
                seen.add(title)
                found.append(title)
        return found

    def explain_empty(self, ref: str, html: str) -> str:
        """
        Say *why* nothing was found, because 'no episodes' on Wikipedia almost
        always means the wrong article rather than missing data.
        """
        if "module-episode-list-row" not in html:
            subs = self.sub_articles(html)
            if subs:
                listing = "\n".join(f"    {s}" for s in subs[:12])
                return (f"'{ref}' has no episode tables of its own - this show splits its "
                        f"episodes across sub-articles. Use one of these instead:\n{listing}")
            return (f"'{ref}' contains no episode tables. Wikipedia keeps them in a "
                    f"'List of <show> episodes' article - try searching for that rather "
                    f"than the show's main article.")
        return (f"'{ref}' has episode tables, but none under a heading this tool reads as "
                "episode content. Sections for spin-offs, home media and references are "
                "skipped deliberately so their rows are not mixed into the seasons.")

    def fetch_detail(self, ref: str, episode: dict) -> None:
        """Nothing extra to fetch: the article table already carries everything."""

    def cast(self, ref: str, language: str = "Japanese") -> list[dict]:
        return []          # episode-list articles carry no usable cast data


# --------------------------------------------------------------------------- #

SOURCE_CLASSES = {cls.key: cls for cls in (MalSource, TvdbSource, WikipediaSource)}


def get_source(key: str, cancel=None, log=None):
    try:
        return SOURCE_CLASSES[key](cancel=cancel, log=log)
    except KeyError:
        raise ScrapeError(f"Unknown source '{key}'. Choose from: {', '.join(SOURCE_CLASSES)}")
