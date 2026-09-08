"""
Reference run: drives the Python tool over the fixtures in fixtures/ and dumps
everything it produces to py.json, for port.mjs to be compared against.

    cd web/test
    python ref.py && node port.mjs && python diff.py

Network is never touched — WebClient.get is replaced with a fixture lookup.
"""

import dataclasses
import io
import json
import os
import sys
import xml.etree.ElementTree as ET
from html.entities import html5
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..')))

import sources                      # noqa: E402
import nfo_exporter as nx           # noqa: E402

F = os.path.join(HERE, 'fixtures')


def fix(name):
    return io.open(os.path.join(F, name), encoding='utf-8').read()


ROUTES = {}


def install(source_obj, routes):
    ROUTES.clear()
    ROUTES.update(routes)
    source_obj.get = lambda url, retries=4: _serve(url)


def _serve(url):
    for needle, name in ROUTES.items():
        if needle in url:
            return fix(name)
    raise sources.ScrapeError('no fixture for ' + url)


def render(root):
    ET.indent(root, space='  ')
    return ('<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n'
            + ET.tostring(root, encoding='unicode') + '\n')


out = {}

# --------------------------------------------------------------------- MAL --
mal = sources.MalSource()
install(mal, {'/_/characters': 'mal_characters.html',
              '/_/episode?': 'mal_episodes.html',
              '/_/episode/': 'mal_episode_page.html',
              '/anime/16498': 'mal_show.html'})
mal_show = mal.show('16498')
out['mal_show'] = dataclasses.asdict(mal_show)
out['mal_episodes'] = sources.parse_mal_episode_rows(fix('mal_episodes.html'), '16498')
out['mal_cast_ja'] = mal.cast('16498', 'Japanese')
out['mal_cast_en'] = mal.cast('16498', 'English')
out['mal_ep_synopsis'] = sources.parse_mal_episode_synopsis(fix('mal_episode_page.html'))

# -------------------------------------------------------------------- TVDB --
tvdb = sources.TvdbSource()
install(tvdb, {'/allseasons/official': 'tvdb_seasons.html',
               '/episodes/': 'tvdb_episode.html',
               '/series/': 'tvdb_show.html'})
tvdb_show = tvdb.show('attack-on-titan')
out['tvdb_show'] = dataclasses.asdict(tvdb_show)
out['tvdb_episodes'] = tvdb.episodes('attack-on-titan')
out['tvdb_cast'] = tvdb.cast('attack-on-titan')
ep = dict(out['tvdb_episodes'][1])
tvdb.fetch_detail('attack-on-titan', ep)
out['tvdb_detail'] = ep

# --------------------------------------------------------------- Wikipedia --
wiki = sources.WikipediaSource()
wiki.page_html = lambda ref: fix('wiki_page.html')
wiki_show = wiki.show('List of Attack on Titan episodes')
out['wiki_show'] = dataclasses.asdict(wiki_show)
out['wiki_episodes'] = wiki.episodes('List of Attack on Titan episodes')

# ----------------------------------------------------------------- helpers --
out['helpers'] = {
    'safe_filename': [nx.safe_filename(s) for s in
                      ['Re:Zero / Season 1', 'CON', 'A  b\tc.', '<bad>|name?',
                       'x' * 200, '', ':::']],
    'parse_text_date': [sources.parse_text_date(s) for s in
                        ['Jul 7, 2000', 'April 7, 2013', '2013-04-07', 'Sept 2013', '']],
    'parse_date_range': [list(sources.parse_date_range(s)) for s in
                         ['Sep 29, 2023 to Mar 22, 2024', 'Apr 7, 2013 to ?', 'Not available']],
    'duration': [sources.duration_to_seconds(s) for s in
                 ['24 min. per ep.', '1 hr. 41 min.', '25 minutes', '30 sec.', 'Unknown']],
    'rating_token': [sources.rating_token(s) for s in
                     ['PG-13 - Teens 13 or older', 'R+ - Mild Nudity', 'G', '']],
    'mpaa': [nx.mpaa_from_token(s) for s in ['PG-13', 'r', 'RX', 'Q', '']],
    'flip_name': [sources.flip_name(s) for s in ['Ichinose, Kana', 'Cher', 'A, B, C']],
    'strip_tags': [sources.strip_tags(s) for s in
                   ['<b>a</b>&amp;<i>b</i>', 'x&nbsp;y', '&#x27;q&#x27;']],
    'strip_tags_breaks': [sources.strip_tags(s, True) for s in
                          ['<p>one</p><p>two</p>', 'a<br>b<br/>c']],
    'full_image_url': [sources.full_image_url(s) for s in
                       ['https://cdn.myanimelist.net/r/200x300/images/a.jpg?s=1',
                        'https://x/y.webp']],
    'poster_candidates': [nx.poster_candidates(s) for s in
                          ['https://x/y.webp', 'https://x/y.jpg', '']],
    'iso_date': [nx.iso_date(s) for s in ['2013-04-07T00:00', 'bad', '']],
    'split_alt_title': [list(sources.split_alt_title(s)) for s in
                        ['Romaji (Japanese)', 'Only Romaji', '', 'A (B) (C)']],
    'premiered': [list(sources.parse_premiered(s)) for s in
                  ['Fall 2023', '2011', 'nothing']],
}

# --------------------------------------------------------------------- XML --
opts = nx.ExportOptions(ref='16498', output_root=Path('.'), source='mal', season=1,
                        show_name='', prefer_english=True, tmdb_id='1429',
                        extra_genres=['Custom Genre', 'action'])
out['xml_tvshow_mal'] = render(nx.build_tvshow_xml(mal_show, opts, out['mal_cast_ja']))
out['xml_season_mal'] = render(nx.build_season_xml(mal_show, 1, opts))
out['xml_episode_mal'] = render(nx.build_episode_xml(
    out['mal_episodes'][0], mal_show, opts, 'Attack on Titan', 1, 1, False))

topts = nx.ExportOptions(ref='attack-on-titan', output_root=Path('.'), source='tvdb',
                         season=1, all_seasons=True)
out['xml_tvshow_tvdb'] = render(nx.build_tvshow_xml(tvdb_show, topts, out['tvdb_cast']))
out['xml_episode_tvdb'] = render(nx.build_episode_xml(
    out['tvdb_episodes'][0], tvdb_show, topts, 'Attack on Titan', 0, 20, True))

wopts = nx.ExportOptions(ref='List of Attack on Titan episodes', output_root=Path('.'),
                         source='wikipedia', season=1, all_seasons=True)
out['xml_episode_wiki'] = render(nx.build_episode_xml(
    out['wiki_episodes'][0], wiki_show, wopts, 'Attack on Titan', 1, 1, True))

json.dump(out, io.open(os.path.join(HERE, 'py.json'), 'w', encoding='utf-8'),
          indent=1, ensure_ascii=False, sort_keys=True)

# The Node stub has no HTML parser, so hand it Python's HTML5 entity table —
# the same named-character-reference list a browser decodes with.
json.dump(html5, io.open(os.path.join(HERE, 'entities.json'), 'w', encoding='utf-8'))

print(f'python reference written: {len(out)} sections')
