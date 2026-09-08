#!/usr/bin/env python3
"""
Emby NFO Exporter -- episode metadata from MyAnimeList, TheTVDB or Wikipedia.

Writes Emby-compatible NFO files, split into season folders, with a tvshow.nfo
for the series:

    <Output>/<Show Name> (Year)/
        tvshow.nfo
        folder.jpg                     (optional poster download)
        Season 01/
            season.nfo
            <Show Name> S01E01.nfo
            ...
        Season 02/
            ...

Three interchangeable sources, none of which need an API key -- see sources.py:

  mal        richest anime metadata, but MAL has no season numbering, so one MAL
             entry = one season and you run it once per entry
  tvdb       real season/episode numbering: one run writes every season, plus
             specials as Season 00, and supplies TVDB/IMDB/TMDB ids for Emby
  wikipedia  episode tables with directors, writers and ISO air dates

    python exporter.py            # GUI
    python exporter.py --help     # CLI
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sys
import threading
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from sources import (
    APP_VERSION, CAST_LIMIT, SOURCES, SOURCE_CLASSES, Cancelled, ScrapeError, Show,
    clean_text, get_source, parse_int,
)

APP_NAME = "Emby NFO Exporter"
CONFIG_NAME = "nfo_exporter_config.json"

# Age-rating token -> Emby/Kodi <mpaa> value.
MPAA_MAP = {
    "G": "TV-G", "PG": "TV-Y7", "PG-13": "TV-14",
    "R": "TV-MA", "R+": "TV-MA", "RX": "TV-MA",
}

# Normalised airing status -> Emby <status> value.
STATUS_MAP = {
    "finished airing": "Ended", "ended": "Ended", "completed": "Ended",
    "currently airing": "Continuing", "continuing": "Continuing",
    "not yet aired": "Continuing", "upcoming": "Continuing",
}

CAST_LANGUAGES = ["Japanese", "English", "German", "Spanish", "French",
                  "Italian", "Portuguese (BR)", "Korean", "Mandarin", "Hungarian"]

_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def config_path() -> Path:
    return app_dir() / CONFIG_NAME


def load_config() -> dict:
    try:
        return json.loads(config_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(values: dict) -> None:
    try:
        merged = load_config()
        merged.update(values)
        config_path().write_text(json.dumps(merged, indent=2), encoding="utf-8")
    except OSError:
        pass  # a read-only USB stick should not break an otherwise good export


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def safe_filename(name: str, fallback: str = "Untitled") -> str:
    """Make a string safe as a single Windows path component."""
    name = clean_text(name)
    name = name.replace(":", " -").replace("/", "-").replace("\\", "-")
    name = re.sub(r'[<>"|?*]', "", name)
    name = re.sub(r"\s+", " ", name).strip().rstrip(". ")
    if name.upper() in _WIN_RESERVED:
        name = f"_{name}"
    return name[:120].strip() or fallback


def iso_date(value) -> str:
    if not value:
        return ""
    match = re.match(r"(\d{4}-\d{2}-\d{2})", str(value))
    return match.group(1) if match else ""


def mpaa_from_token(token: str) -> str:
    return MPAA_MAP.get(str(token or "").strip().upper(), "")


def poster_candidates(url: str) -> list[str]:
    """
    Prefer a .jpg over a .webp: MAL's CDN serves both for the same image, and
    folder.jpg is the safest thing to put in front of Emby.
    """
    if not url:
        return []
    if url.lower().endswith(".webp"):
        return [f"{url[:-5]}.jpg", url]
    return [url]


def write_xml(path: Path, root: ET.Element) -> None:
    """Write an indented, UTF-8, Emby-friendly NFO document."""
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write('<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n')
        handle.write(body)
        handle.write("\n")


def sub(parent: ET.Element, tag: str, text, **attrs) -> ET.Element | None:
    """Append <tag>text</tag> only when there is actually text to write."""
    text = clean_text(text)
    if not text:
        return None
    node = ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})
    node.text = text
    return node


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #

@dataclass
class ExportOptions:
    ref: str                          # MAL id / TVDB slug / Wikipedia title
    output_root: Path
    source: str = "mal"
    season: int = 1                   # season to assign, or to filter to
    all_seasons: bool = False         # season-aware sources: write every season
    show_name: str = ""               # blank -> derive from the source
    episode_offset: int = 0
    prefer_english: bool = True
    fetch_synopsis: bool = False      # one extra page fetch per episode
    write_tvshow: bool = True
    write_season_nfo: bool = True
    include_cast: bool = True
    cast_language: str = "Japanese"
    download_poster: bool = False
    overwrite: bool = True
    year_in_folder: bool = True
    tvdb_id: str = ""
    tmdb_id: str = ""
    imdb_id: str = ""
    anidb_id: str = ""
    extra_genres: list[str] = field(default_factory=list)


@dataclass
class ExportResult:
    show_folder: Path
    season_folders: list[Path] = field(default_factory=list)
    per_season: dict[int, int] = field(default_factory=dict)
    episodes_written: int = 0
    episodes_skipped: int = 0
    synopses_found: int = 0
    synopses_missing: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def season_folder(self) -> Path | None:
        return self.season_folders[0] if self.season_folders else None


def build_tvshow_xml(show: Show, options: ExportOptions, cast: list[dict]) -> ET.Element:
    root = ET.Element("tvshow")
    title = options.show_name or show.display_title(options.prefer_english)

    sub(root, "title", title)
    sub(root, "originaltitle", show.title_japanese or show.title)
    sub(root, "sorttitle", title)
    sub(root, "plot", show.synopsis)
    sub(root, "outline", show.synopsis)

    if show.score:
        sub(root, "rating", f"{float(show.score):.2f}")
        # Half-up, not round(): banker's rounding would turn 9.25 into 92, not 93.
        sub(root, "criticrating", int(float(show.score) * 10 + 0.5))
    sub(root, "votes", show.scored_by)

    sub(root, "mpaa", mpaa_from_token(show.rating_token))
    sub(root, "premiered", show.aired_from)
    sub(root, "releasedate", show.aired_from)
    sub(root, "year", show.display_year)
    sub(root, "enddate", show.aired_to)
    sub(root, "status", STATUS_MAP.get(show.status, ""))
    sub(root, "runtime", show.runtime_minutes)

    for studio in show.studios:
        sub(root, "studio", studio)
    for network in show.networks:
        sub(root, "studio", network)

    seen = set()
    for name in [*show.genres, *options.extra_genres]:
        name = clean_text(name)
        if name and name.lower() not in seen:
            seen.add(name.lower())
            sub(root, "genre", name)

    sub(root, "tag", "Anime")
    for name in show.demographics:
        sub(root, "tag", name)
    if show.season:
        sub(root, "tag", f"{show.season.capitalize()} {show.display_year}".strip())
    sub(root, "trailer", show.trailer)

    # Provider IDs are what actually let Emby lock onto the right series.
    # Exactly one uniqueid may carry default="true", and a given type must appear
    # once: writing the TVDB *slug* as type="tvdb" alongside the numeric TVDB id
    # would be two contradictory values for the same provider.
    provider_ids = []
    for key in ("tvdb", "tmdb", "imdb", "anidb"):
        value = getattr(options, f"{key}_id", "") or getattr(show, f"{key}_id", "")
        if value:
            provider_ids.append((key, value))

    source_type = show.source or "source"
    default_used = False
    if source_type not in {key for key, _ in provider_ids}:
        sub(root, "uniqueid", show.ref, type=source_type, default="true")
        default_used = True
        if show.source == "mal":
            sub(root, "malid", show.ref)
    for key, value in provider_ids:
        attrs = {"type": key}
        if not default_used:
            attrs["default"] = "true"
            default_used = True
        sub(root, "uniqueid", value, **attrs)
        sub(root, f"{key}id", value)
    sub(root, "sourceurl", show.url)

    for index, actor in enumerate(cast):
        node = ET.SubElement(root, "actor")
        sub(node, "name", actor["name"])
        sub(node, "role", actor["role"])
        sub(node, "type", "Actor")
        sub(node, "sortorder", index)
        sub(node, "thumb", actor.get("thumb"))

    if show.poster:
        art = ET.SubElement(root, "art")
        sub(art, "poster", show.poster)

    return root


def build_season_xml(show: Show, season: int, options: ExportOptions) -> ET.Element:
    root = ET.Element("season")
    sub(root, "title", "Specials" if season == 0 else f"Season {season}")
    sub(root, "seasonnumber", season)
    sub(root, "plot", show.synopsis)
    sub(root, "premiered", show.aired_from)
    sub(root, "year", show.display_year)
    sub(root, "uniqueid", show.ref, type=show.source or "source", default="true")
    if show.poster:
        art = ET.SubElement(root, "art")
        sub(art, "poster", show.poster)
    return root


def build_episode_xml(episode: dict, show: Show, options: ExportOptions, show_title: str,
                      season: int, episode_number: int, has_seasons: bool) -> ET.Element:
    root = ET.Element("episodedetails")

    sub(root, "title", episode.get("title") or f"Episode {episode_number}")
    sub(root, "originaltitle", episode.get("title_japanese"))
    sub(root, "showtitle", show_title)
    sub(root, "season", season)
    sub(root, "episode", episode_number)
    sub(root, "displayseason", season)
    sub(root, "displayepisode", episode_number)

    aired = iso_date(episode.get("aired"))
    sub(root, "aired", aired)
    if aired:
        sub(root, "year", aired[:4])

    sub(root, "plot", episode.get("synopsis"))

    score = episode.get("score")
    if score:
        sub(root, "rating", f"{float(score):.2f}")

    runtime = episode.get("runtime")
    sub(root, "runtime", str(runtime) if runtime else show.runtime_minutes)
    sub(root, "mpaa", mpaa_from_token(show.rating_token))

    for person in [p.strip() for p in (episode.get("director") or "").split(",") if p.strip()]:
        sub(root, "director", person)
    for person in [p.strip() for p in (episode.get("writer") or "").split(",") if p.strip()]:
        sub(root, "credits", person)

    for studio in show.studios:
        sub(root, "studio", studio)

    number = episode.get("number")
    if number is not None:
        # Namespaced type: a composite like "attack-on-titan-1x1" is not a real
        # provider episode id, and writing it as type="tvdb" would mislead Emby.
        ident = f"{show.ref}-{season}x{number}" if has_seasons else f"{show.ref}-{number}"
        sub(root, "uniqueid", ident, type=f"{show.source or 'source'}episode")
        sub(root, "sourceepisodenumber", number)
    sub(root, "sourceurl", episode.get("url"))

    return root


def run_export(options: ExportOptions, log=print, progress=None, cancel=None) -> ExportResult:
    """Pull everything for one series from the chosen source and write the NFO tree."""
    cancel = cancel or threading.Event()
    source = get_source(options.source, cancel=cancel, log=log)

    def tick(done: int, total: int, label: str) -> None:
        if progress:
            progress(done, total, label)

    log(f"Fetching '{options.ref}' from {source.label} ...")
    tick(0, 1, "Fetching show details")
    show = source.show(options.ref)

    show_title = options.show_name or show.display_title(options.prefer_english)
    year = show.display_year
    log(f"  {show_title}" + (f" ({year})" if year else "")
        + f" - {show.media_type or '?'}"
        + (f", {show.episode_count} episodes listed" if show.episode_count else ""))

    # An explicit show name defines the folder verbatim. Appending the year here
    # would send each sequel to its own folder (a 2026 season 2 next to a 2023
    # season 1), which breaks the one-entry-per-season workflow.
    if options.show_name:
        folder_name = safe_filename(options.show_name)
    else:
        folder_name = safe_filename(
            f"{show_title} ({year})" if (options.year_in_folder and year) else show_title)
    show_folder = options.output_root / folder_name
    result = ExportResult(show_folder=show_folder)

    cast: list[dict] = []
    if options.include_cast:
        log("Fetching cast ...")
        tick(0, 1, "Fetching cast")
        cast = source.cast(options.ref, options.cast_language)
        log(f"  {len(cast)} actors"
            + (f" ({options.cast_language})" if source.key == "mal" else ""))
        if not cast:
            result.warnings.append(f"{source.label} returned no cast for this entry.")

    log("Fetching episode list ...")

    def on_page(page: int, last: int, running_total: int) -> None:
        if last > 1:
            log(f"  page {page}/{last} - {running_total} episodes so far")
        tick(page, last, "Fetching episode list")

    episodes = source.episodes(options.ref, on_page=on_page)
    if not episodes:
        raise ScrapeError(
            f"{source.label} lists no episodes for this entry. Movies and single-episode "
            "OVAs have no episode list; on Wikipedia, make sure the article is the "
            "'List of ... episodes' one."
        )
    log(f"  {len(episodes)} episodes retrieved")

    # Group into seasons. Sources without season numbering get the chosen season.
    grouped: dict[int, list[dict]] = {}
    for episode in episodes:
        season = episode.get("season")
        season = options.season if season is None else int(season)
        grouped.setdefault(season, []).append(episode)

    if len(grouped) > 1 and not options.all_seasons:
        wanted = grouped.get(options.season, [])
        dropped = sum(len(v) for k, v in grouped.items() if k != options.season)
        grouped = {options.season: wanted}
        log(f"  restricted to season {options.season}"
            f" ({dropped} episodes in other seasons skipped - use all-seasons to include them)")
        if not wanted:
            raise ScrapeError(
                f"{source.label} has no season {options.season} for this series. "
                "Enable all-seasons, or pick a season that exists."
            )
    if len(grouped) > 1:
        log("  seasons found: " + ", ".join(
            f"{'Specials' if s == 0 else s}={len(v)}" for s, v in sorted(grouped.items())))

    # Per-episode detail is one page fetch each, so only do it for the episodes
    # that survived the season filter -- not for every season we are discarding.
    if options.fetch_synopsis:
        keep = [e for season in sorted(grouped) for e in grouped[season]]
        log(f"  fetching per-episode detail for {len(keep)} episodes "
            "(one page each, so this is slow) ...")
        for index, episode in enumerate(keep, start=1):
            if cancel.is_set():
                raise Cancelled()
            source.fetch_detail(options.ref, episode)
            tick(index, len(keep), f"Episode detail {index}/{len(keep)}")
            if index % 25 == 0 or index == len(keep):
                log(f"    {index}/{len(keep)}")

    show_folder.mkdir(parents=True, exist_ok=True)

    if options.write_tvshow:
        path = show_folder / "tvshow.nfo"
        if path.exists() and not options.overwrite:
            log("Skipped tvshow.nfo (already exists)")
        else:
            write_xml(path, build_tvshow_xml(show, options, cast))
            log(f"Wrote {path.name}")

    if options.download_poster:
        candidates = poster_candidates(show.poster)
        if candidates:
            existing = next((show_folder / f"folder{ext}" for ext in (".jpg", ".webp", ".png")
                             if (show_folder / f"folder{ext}").exists()), None)
            if existing and not options.overwrite:
                log(f"Skipped {existing.name} (already exists)")
            else:
                last_exc = None
                for url in candidates:
                    suffix = Path(urllib.parse.urlparse(url).path).suffix or ".jpg"
                    target = show_folder / f"folder{suffix}"
                    try:
                        source.download(url, target)
                        log(f"Downloaded {target.name}")
                        last_exc = None
                        break
                    except (urllib.error.URLError, OSError, TimeoutError) as exc:
                        last_exc = exc
                if last_exc is not None:
                    result.warnings.append(f"Poster download failed: {last_exc}")
                    log(f"  poster download failed: {last_exc}")
        else:
            result.warnings.append(f"{source.label} has no poster image for this entry.")

    total = sum(len(v) for v in grouped.values())
    done = 0
    for season in sorted(grouped):
        season_episodes = grouped[season]
        season_folder = show_folder / f"Season {season:02d}"
        season_folder.mkdir(parents=True, exist_ok=True)
        result.season_folders.append(season_folder)

        if options.write_season_nfo:
            path = season_folder / "season.nfo"
            if path.exists() and not options.overwrite:
                log(f"Skipped Season {season:02d}/season.nfo (already exists)")
            else:
                write_xml(path, build_season_xml(show, season, options))
                log(f"Wrote Season {season:02d}/season.nfo")

        log(f"Writing {len(season_episodes)} episode NFO files to {season_folder} ...")
        written = 0
        for index, episode in enumerate(season_episodes, start=1):
            if cancel.is_set():
                raise Cancelled()
            done += 1

            raw_number = episode.get("number")
            base_number = raw_number if isinstance(raw_number, int) else index
            episode_number = base_number + options.episode_offset
            if episode_number < 0:
                episode_number = index + options.episode_offset

            name = f"{safe_filename(show_title)} S{season:02d}E{episode_number:02d}"
            path = season_folder / f"{name}.nfo"

            if path.exists() and not options.overwrite:
                result.episodes_skipped += 1
                tick(done, total, f"Skipped S{season:02d}E{episode_number:02d}")
                continue

            if options.fetch_synopsis:
                if clean_text(episode.get("synopsis")):
                    result.synopses_found += 1
                else:
                    result.synopses_missing += 1

            write_xml(path, build_episode_xml(episode, show, options, show_title,
                                              season, episode_number, source.has_seasons))
            result.episodes_written += 1
            written += 1
            tick(done, total,
                 f"S{season:02d}E{episode_number:02d} - {clean_text(episode.get('title'))[:38]}")
        result.per_season[season] = written

    if options.fetch_synopsis and result.synopses_missing:
        result.warnings.append(
            f"{result.synopses_missing} of {total} episodes had no plot on {source.label}.")
    if source.key == "wikipedia" and options.write_tvshow:
        result.warnings.append(
            "Wikipedia has little series-level data, so tvshow.nfo is sparse. For richer "
            "series details, run MyAnimeList first, then Wikipedia with tvshow.nfo disabled.")

    log("")
    log(f"Done. {result.episodes_written} episode NFOs written across "
        f"{len(result.per_season)} season(s)"
        + (f", {result.episodes_skipped} skipped" if result.episodes_skipped else "") + ".")
    for warning in result.warnings:
        log(f"Warning: {warning}")
    return result


# --------------------------------------------------------------------------- #
# GUI
# --------------------------------------------------------------------------- #

def launch_gui() -> int:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    config = load_config()

    root = tk.Tk()
    root.title(f"{APP_NAME} v{APP_VERSION}")
    root.geometry("930x830")
    root.minsize(800, 700)

    messages: queue.Queue = queue.Queue()
    cancel_event = threading.Event()
    state: dict = {"worker": None, "results": []}

    var_source = tk.StringVar(value=config.get("source", "mal"))
    var_query = tk.StringVar()
    var_ref = tk.StringVar()
    var_show_name = tk.StringVar()
    var_season = tk.StringVar(value="1")
    var_all_seasons = tk.BooleanVar(value=config.get("all_seasons", True))
    var_offset = tk.StringVar(value="0")
    var_output = tk.StringVar(value=config.get("output") or str(Path.home() / "Desktop" / "NFO"))
    var_english = tk.BooleanVar(value=config.get("prefer_english", True))
    var_synopsis = tk.BooleanVar(value=config.get("fetch_synopsis", False))
    var_tvshow = tk.BooleanVar(value=config.get("write_tvshow", True))
    var_season_nfo = tk.BooleanVar(value=config.get("write_season_nfo", True))
    var_cast = tk.BooleanVar(value=config.get("include_cast", True))
    var_cast_lang = tk.StringVar(value=config.get("cast_language", "Japanese"))
    var_poster = tk.BooleanVar(value=config.get("download_poster", False))
    var_overwrite = tk.BooleanVar(value=config.get("overwrite", True))
    var_year_folder = tk.BooleanVar(value=config.get("year_in_folder", True))
    var_tvdb = tk.StringVar()
    var_tmdb = tk.StringVar()
    var_anidb = tk.StringVar()
    var_status = tk.StringVar(value="Ready.")
    var_hint = tk.StringVar()

    outer = ttk.Frame(root, padding=12)
    outer.pack(fill="both", expand=True)

    # ---- source + search ----
    search_box = ttk.LabelFrame(outer, text="1. Source and series", padding=10)
    search_box.pack(fill="x")
    search_box.columnconfigure(1, weight=1)

    src_row = ttk.Frame(search_box)
    src_row.grid(row=0, column=0, columnspan=3, sticky="w")
    ttk.Label(src_row, text="Source:").pack(side="left")
    combo_source = ttk.Combobox(src_row, textvariable=var_source, width=12, state="readonly",
                               values=list(SOURCES))
    combo_source.pack(side="left", padx=(6, 10))
    ttk.Label(src_row, textvariable=var_hint, foreground="#666").pack(side="left")

    ttk.Label(search_box, text="Search:").grid(row=1, column=0, sticky="w", pady=(8, 0))
    entry_query = ttk.Entry(search_box, textvariable=var_query)
    entry_query.grid(row=1, column=1, sticky="ew", padx=6, pady=(8, 0))
    btn_search = ttk.Button(search_box, text="Search")
    btn_search.grid(row=1, column=2, pady=(8, 0))

    results_frame = ttk.Frame(search_box)
    results_frame.grid(row=2, column=0, columnspan=3, sticky="ew", pady=(8, 0))
    results_frame.columnconfigure(0, weight=1)
    listbox = tk.Listbox(results_frame, height=8, exportselection=False, activestyle="dotbox")
    listbox.grid(row=0, column=0, sticky="ew")
    scroll = ttk.Scrollbar(results_frame, orient="vertical", command=listbox.yview)
    scroll.grid(row=0, column=1, sticky="ns")
    listbox.configure(yscrollcommand=scroll.set)

    ref_row = ttk.Frame(search_box)
    ref_row.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(8, 0))
    ttk.Label(ref_row, text="Series ref:").pack(side="left")
    ttk.Entry(ref_row, textvariable=var_ref, width=46).pack(side="left", padx=6)
    ttk.Label(ref_row, text="(or paste it directly)").pack(side="left")

    # ---- output ----
    out_box = ttk.LabelFrame(outer, text="2. Output", padding=10)
    out_box.pack(fill="x", pady=(10, 0))
    out_box.columnconfigure(1, weight=1)

    ttk.Label(out_box, text="Folder:").grid(row=0, column=0, sticky="w")
    ttk.Entry(out_box, textvariable=var_output).grid(row=0, column=1, sticky="ew", padx=6)

    def browse() -> None:
        chosen = filedialog.askdirectory(title="Choose the output folder", mustexist=False)
        if chosen:
            var_output.set(str(Path(chosen)))

    ttk.Button(out_box, text="Browse...", command=browse).grid(row=0, column=2)

    ttk.Label(out_box, text="Show name:").grid(row=1, column=0, sticky="w", pady=(8, 0))
    ttk.Entry(out_box, textvariable=var_show_name).grid(row=1, column=1, columnspan=2,
                                                       sticky="ew", padx=6, pady=(8, 0))
    ttk.Label(out_box, foreground="#666",
              text="Blank uses the source's own title. Set it to the same base title on every "
                   "run to keep seasons in one folder.").grid(row=2, column=1, columnspan=2,
                                                             sticky="w", padx=6)

    num_row = ttk.Frame(out_box)
    num_row.grid(row=3, column=0, columnspan=3, sticky="w", pady=(8, 0))
    chk_all = ttk.Checkbutton(num_row, text="All seasons", variable=var_all_seasons)
    chk_all.pack(side="left", padx=(0, 14))
    ttk.Label(num_row, text="Season:").pack(side="left")
    spin_season = ttk.Spinbox(num_row, from_=0, to=99, width=5, textvariable=var_season)
    spin_season.pack(side="left", padx=(6, 18))
    ttk.Label(num_row, text="Episode offset:").pack(side="left")
    ttk.Spinbox(num_row, from_=-500, to=5000, width=7,
                textvariable=var_offset).pack(side="left", padx=6)

    id_row = ttk.Frame(out_box)
    id_row.grid(row=4, column=0, columnspan=3, sticky="w", pady=(8, 0))
    ttk.Label(id_row, text="Provider IDs -  TVDB:").pack(side="left")
    ttk.Entry(id_row, textvariable=var_tvdb, width=10).pack(side="left", padx=(4, 10))
    ttk.Label(id_row, text="TMDB:").pack(side="left")
    ttk.Entry(id_row, textvariable=var_tmdb, width=10).pack(side="left", padx=(4, 10))
    ttk.Label(id_row, text="AniDB:").pack(side="left")
    ttk.Entry(id_row, textvariable=var_anidb, width=10).pack(side="left", padx=4)
    ttk.Label(id_row, text="(TVDB source fills these in for you)",
              foreground="#666").pack(side="left", padx=8)

    # ---- options ----
    opt_box = ttk.LabelFrame(outer, text="3. Options", padding=10)
    opt_box.pack(fill="x", pady=(10, 0))
    left = ttk.Frame(opt_box)
    left.pack(side="left", fill="both", expand=True)
    right = ttk.Frame(opt_box)
    right.pack(side="left", fill="both", expand=True)

    ttk.Checkbutton(left, text="Prefer English titles", variable=var_english).pack(anchor="w")
    ttk.Checkbutton(left, text="Write tvshow.nfo", variable=var_tvshow).pack(anchor="w")
    ttk.Checkbutton(left, text="Write season.nfo", variable=var_season_nfo).pack(anchor="w")
    ttk.Checkbutton(left, text="Overwrite existing NFO files", variable=var_overwrite).pack(anchor="w")

    ttk.Checkbutton(right, text="Include year in show folder name",
                    variable=var_year_folder).pack(anchor="w")
    ttk.Checkbutton(right, text="Download poster as folder.jpg", variable=var_poster).pack(anchor="w")
    cast_row = ttk.Frame(right)
    cast_row.pack(anchor="w", fill="x")
    chk_cast = ttk.Checkbutton(cast_row, text="Include cast -", variable=var_cast)
    chk_cast.pack(side="left")
    combo_lang = ttk.Combobox(cast_row, textvariable=var_cast_lang, width=14, state="readonly",
                              values=CAST_LANGUAGES)
    combo_lang.pack(side="left", padx=4)
    chk_syn = ttk.Checkbutton(right, variable=var_synopsis,
                              text="Fetch per-episode detail (slow: one page each)")
    chk_syn.pack(anchor="w")

    # ---- run ----
    run_box = ttk.Frame(outer)
    run_box.pack(fill="x", pady=(12, 0))
    btn_export = ttk.Button(run_box, text="Export NFO files")
    btn_export.pack(side="left")
    btn_cancel = ttk.Button(run_box, text="Cancel", state="disabled")
    btn_cancel.pack(side="left", padx=6)
    btn_open = ttk.Button(run_box, text="Open output folder", state="disabled")
    btn_open.pack(side="left", padx=6)

    progress = ttk.Progressbar(outer, mode="determinate", maximum=100)
    progress.pack(fill="x", pady=(10, 4))
    ttk.Label(outer, textvariable=var_status).pack(anchor="w")

    log_box = ttk.LabelFrame(outer, text="Log", padding=6)
    log_box.pack(fill="both", expand=True, pady=(8, 0))
    log_text = tk.Text(log_box, height=11, wrap="word", state="disabled")
    log_text.pack(side="left", fill="both", expand=True)
    log_scroll = ttk.Scrollbar(log_box, orient="vertical", command=log_text.yview)
    log_scroll.pack(side="right", fill="y")
    log_text.configure(yscrollcommand=log_scroll.set)

    # ---- plumbing ----
    def append_log(line: str) -> None:
        log_text.configure(state="normal")
        log_text.insert("end", line + "\n")
        log_text.see("end")
        log_text.configure(state="disabled")

    def busy(is_busy: bool) -> None:
        btn_export.configure(state="disabled" if is_busy else "normal")
        btn_search.configure(state="disabled" if is_busy else "normal")
        btn_cancel.configure(state="normal" if is_busy else "disabled")

    def current_source():
        return SOURCE_CLASSES.get(var_source.get(), SOURCE_CLASSES["mal"])

    def on_source_change(*_args) -> None:
        cls = current_source()
        var_hint.set(cls.ref_hint)
        # Only MAL has per-language voice-actor data; only MAL lacks seasons.
        combo_lang.configure(state="readonly" if cls.key == "mal" else "disabled")
        chk_all.configure(state="normal" if cls.has_seasons else "disabled")
        chk_cast.configure(state="disabled" if cls.key == "wikipedia" else "normal")
        listbox.delete(0, "end")
        state["results"] = []

    var_source.trace_add("write", on_source_change)

    def pump() -> None:
        try:
            while True:
                kind, payload = messages.get_nowait()
                if kind == "log":
                    append_log(payload)
                elif kind == "status":
                    var_status.set(payload)
                elif kind == "progress":
                    done, total, label = payload
                    progress.configure(value=(done / total * 100) if total else 0)
                    var_status.set(f"{label}  ({done}/{total})" if total else label)
                elif kind == "results":
                    state["results"] = payload
                    listbox.delete(0, "end")
                    for hit in payload:
                        listbox.insert("end", "  " + hit.describe())
                    var_status.set(f"{len(payload)} results. Pick one to fill in the ref."
                                   if payload else "No results.")
                elif kind == "done":
                    busy(False)
                    progress.configure(value=100)
                    result: ExportResult = payload
                    btn_open.configure(state="normal")
                    state["last_folder"] = result.show_folder
                    var_status.set(f"Finished - {result.episodes_written} episode NFOs.")
                    seasons = ", ".join(f"S{s:02d}={n}" for s, n in sorted(result.per_season.items()))
                    messagebox.showinfo(
                        "Export complete",
                        f"{result.episodes_written} episode NFO files written.\n"
                        f"{seasons}\n\n{result.show_folder}\n\n"
                        + ("\n".join(result.warnings) if result.warnings else "No warnings."))
                elif kind == "error":
                    busy(False)
                    progress.configure(value=0)
                    var_status.set("Failed.")
                    messagebox.showerror("Export failed", str(payload))
                elif kind == "cancelled":
                    busy(False)
                    progress.configure(value=0)
                    var_status.set("Cancelled.")
        except queue.Empty:
            pass
        root.after(80, pump)

    def persist() -> None:
        save_config({
            "source": var_source.get(),
            "output": var_output.get().strip(),
            "all_seasons": var_all_seasons.get(),
            "prefer_english": var_english.get(),
            "fetch_synopsis": var_synopsis.get(),
            "write_tvshow": var_tvshow.get(),
            "write_season_nfo": var_season_nfo.get(),
            "include_cast": var_cast.get(),
            "cast_language": var_cast_lang.get(),
            "download_poster": var_poster.get(),
            "overwrite": var_overwrite.get(),
            "year_in_folder": var_year_folder.get(),
        })

    def do_search() -> None:
        term = var_query.get().strip()
        if not term:
            messagebox.showwarning(APP_NAME, "Type something to search for first.")
            return
        cls = current_source()
        pasted = cls.parse_ref(term)
        if pasted and (term.startswith("http") or term.isdigit()):
            var_ref.set(pasted)
        persist()
        busy(True)
        var_status.set(f"Searching {cls.label} for '{term}' ...")
        key = var_source.get()

        def work() -> None:
            try:
                hits = get_source(key, log=lambda m: messages.put(("log", m))).search(term)
                messages.put(("results", hits))
            except (ScrapeError, Cancelled) as exc:
                messages.put(("error", exc))
            finally:
                root.after(0, lambda: busy(False))

        threading.Thread(target=work, daemon=True).start()

    def on_pick(_event=None) -> None:
        selection = listbox.curselection()
        if not selection or not state["results"]:
            return
        hit = state["results"][selection[0]]
        var_ref.set(hit.ref)
        # Source search tables often carry only the primary (non-English) title,
        # so leave Show name blank and let the details page supply a better one.
        var_show_name.set("")
        var_status.set(f"Selected {hit.ref} - {hit.title}")

    def do_export() -> None:
        cls = current_source()
        ref = cls.parse_ref(var_ref.get()) or var_ref.get().strip()
        if not ref:
            messagebox.showwarning(APP_NAME, f"Pick a search result, or paste a {cls.ref_hint}.")
            return
        output = var_output.get().strip()
        if not output:
            messagebox.showwarning(APP_NAME, "Choose an output folder.")
            return
        try:
            season = int(var_season.get())
            offset = int(var_offset.get())
        except ValueError:
            messagebox.showwarning(APP_NAME, "Season and episode offset must be whole numbers.")
            return

        persist()
        options = ExportOptions(
            ref=ref, output_root=Path(output).expanduser(), source=var_source.get(),
            season=season, all_seasons=var_all_seasons.get() and cls.has_seasons,
            show_name=var_show_name.get().strip(), episode_offset=offset,
            prefer_english=var_english.get(), fetch_synopsis=var_synopsis.get(),
            write_tvshow=var_tvshow.get(), write_season_nfo=var_season_nfo.get(),
            include_cast=var_cast.get() and cls.key != "wikipedia",
            cast_language=var_cast_lang.get(), download_poster=var_poster.get(),
            overwrite=var_overwrite.get(), year_in_folder=var_year_folder.get(),
            tvdb_id=var_tvdb.get().strip(), tmdb_id=var_tmdb.get().strip(),
            anidb_id=var_anidb.get().strip(),
        )

        cancel_event.clear()
        busy(True)
        btn_open.configure(state="disabled")
        progress.configure(value=0)
        append_log("=" * 70)

        def work() -> None:
            try:
                result = run_export(
                    options,
                    log=lambda m: messages.put(("log", m)),
                    progress=lambda d, t, l: messages.put(("progress", (d, t, l))),
                    cancel=cancel_event,
                )
                messages.put(("done", result))
            except Cancelled:
                messages.put(("log", "Cancelled by user."))
                messages.put(("cancelled", None))
            except (ScrapeError, OSError, ValueError) as exc:
                messages.put(("log", f"ERROR: {exc}"))
                messages.put(("error", exc))

        state["worker"] = threading.Thread(target=work, daemon=True)
        state["worker"].start()

    def do_cancel() -> None:
        cancel_event.set()
        var_status.set("Cancelling ...")

    def do_open() -> None:
        folder = state.get("last_folder")
        if folder and Path(folder).exists():
            if sys.platform == "win32":
                os.startfile(str(folder))  # noqa: S606
            else:
                os.system(f'xdg-open "{folder}"' if sys.platform.startswith("linux")
                          else f'open "{folder}"')

    def on_close() -> None:
        persist()
        root.destroy()

    btn_search.configure(command=do_search)
    btn_export.configure(command=do_export)
    btn_cancel.configure(command=do_cancel)
    btn_open.configure(command=do_open)
    entry_query.bind("<Return>", lambda _e: do_search())
    listbox.bind("<<ListboxSelect>>", on_pick)
    listbox.bind("<Double-Button-1>", lambda _e: (on_pick(), do_export()))
    root.protocol("WM_DELETE_WINDOW", on_close)

    on_source_change()
    append_log(f"{APP_NAME} v{APP_VERSION}")
    append_log("Sources: mal (richest anime data) | tvdb (real seasons + Emby ids) | "
               "wikipedia (directors, writers)")
    append_log("No API keys needed. MAL has no seasons, so one MAL entry = one season;")
    append_log("TVDB and Wikipedia can write every season in a single run.")
    append_log("")

    entry_query.focus_set()
    pump()
    root.mainloop()
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="exporter",
        description="Export episode metadata as Emby NFO files from MyAnimeList, "
                    "TheTVDB or Wikipedia. Run with no arguments for the GUI.",
    )
    parser.add_argument("--source", choices=list(SOURCES), default="mal",
                        help="Where to get data from (default: mal)")
    parser.add_argument("--ref", "--id", dest="ref",
                        help="MAL anime ID, TVDB slug, Wikipedia article title, or a URL")
    parser.add_argument("--search", metavar="TERM", help="Search the source and exit")
    parser.add_argument("-o", "--output", default=".", help="Output root folder")
    parser.add_argument("-s", "--season", type=int, default=None,
                        help="Season to write. Omit with tvdb/wikipedia to write every season")
    parser.add_argument("--all-seasons", action="store_true",
                        help="Write every season the source provides (tvdb/wikipedia)")
    parser.add_argument("--name", default="", help="Override the show name (becomes the folder)")
    parser.add_argument("--offset", type=int, default=0, help="Add this to every episode number")
    parser.add_argument("--japanese-titles", action="store_true", help="Prefer romaji/original titles")
    parser.add_argument("--synopsis", action="store_true",
                        help="Fetch per-episode detail: plots, and English titles on TVDB "
                             "(one extra page per episode; slow)")
    parser.add_argument("--no-tvshow", action="store_true", help="Do not write tvshow.nfo")
    parser.add_argument("--no-season-nfo", action="store_true", help="Do not write season.nfo")
    parser.add_argument("--no-cast", action="store_true", help="Do not include actors")
    parser.add_argument("--cast-language", default="Japanese",
                        help="Dub language for MAL cast (default: Japanese)")
    parser.add_argument("--poster", action="store_true", help="Download the poster as folder.jpg")
    parser.add_argument("--no-overwrite", action="store_true", help="Skip files that already exist")
    parser.add_argument("--no-year-folder", action="store_true",
                        help="Omit the year from the show folder name")
    parser.add_argument("--tvdb", default="", help="TVDB series ID to embed")
    parser.add_argument("--tmdb", default="", help="TMDB series ID to embed")
    parser.add_argument("--anidb", default="", help="AniDB series ID to embed")
    args = parser.parse_args(argv)

    if not args.ref and not args.search:
        return launch_gui()

    cls = SOURCE_CLASSES[args.source]

    if args.search:
        try:
            for hit in get_source(args.source).search(args.search):
                print(f"{hit.ref:<44} {hit.describe()}")
        except ScrapeError as exc:
            print(f"Search failed: {exc}", file=sys.stderr)
            return 1
        return 0

    ref = cls.parse_ref(args.ref) or args.ref.strip()
    if not ref:
        print(f"Could not read a {cls.ref_hint} from {args.ref!r}", file=sys.stderr)
        return 2

    # With a season-aware source and no explicit -s, write everything.
    all_seasons = args.all_seasons or (cls.has_seasons and args.season is None)

    options = ExportOptions(
        ref=ref, output_root=Path(args.output).expanduser().resolve(), source=args.source,
        season=1 if args.season is None else args.season, all_seasons=all_seasons,
        show_name=args.name.strip(), episode_offset=args.offset,
        prefer_english=not args.japanese_titles, fetch_synopsis=args.synopsis,
        write_tvshow=not args.no_tvshow, write_season_nfo=not args.no_season_nfo,
        include_cast=not args.no_cast, cast_language=args.cast_language,
        download_poster=args.poster, overwrite=not args.no_overwrite,
        year_in_folder=not args.no_year_folder,
        tvdb_id=args.tvdb.strip(), tmdb_id=args.tmdb.strip(), anidb_id=args.anidb.strip(),
    )

    try:
        run_export(options)
    except Cancelled:
        print("Cancelled.", file=sys.stderr)
        return 130
    except (ScrapeError, OSError, ValueError) as exc:
        print(f"Export failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
