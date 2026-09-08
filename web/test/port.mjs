import './domstub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = new URL('../js/', import.meta.url).href;
const F = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fix = (name) => fs.readFileSync(path.join(F, name), 'utf8');

const util = await import(`${WEB}util.js`);
const nfo = await import(`${WEB}nfo.js`);
const { MalSource } = await import(`${WEB}sources/mal.js`);
const { TvdbSource, parseTvdbAllSeasons, parseTvdbCast } = await import(`${WEB}sources/tvdb.js`);
const { WikipediaSource } = await import(`${WEB}sources/wikipedia.js`);
const mal = await import(`${WEB}sources/mal.js`);

function serve(routes) {
  return async (url) => {
    for (const [needle, name] of Object.entries(routes)) {
      if (url.includes(needle)) return fix(name);
    }
    throw new util.ScrapeError('no fixture for ' + url);
  };
}

const out = {};
const plain = (obj) => JSON.parse(JSON.stringify(obj));

// ---- MAL -------------------------------------------------------------------
const m = new MalSource({});
m.get = serve({ '/_/characters': 'mal_characters.html',
                '/_/episode?': 'mal_episodes.html',
                '/_/episode/': 'mal_episode_page.html',
                '/anime/16498': 'mal_show.html' });
const malShow = await m.show('16498');
out.mal_show = plain(malShow);
out.mal_episodes = mal.parseMalEpisodeRows(fix('mal_episodes.html'), '16498');
out.mal_cast_ja = await m.cast('16498', 'Japanese');
out.mal_cast_en = await m.cast('16498', 'English');
out.mal_ep_synopsis = mal.parseMalEpisodeSynopsis(fix('mal_episode_page.html'));

// ---- TVDB ------------------------------------------------------------------
const t = new TvdbSource({});
t.get = serve({ '/allseasons/official': 'tvdb_seasons.html',
                '/episodes/': 'tvdb_episode.html',
                '/series/': 'tvdb_show.html' });
const tvdbShow = await t.show('attack-on-titan');
out.tvdb_show = plain(tvdbShow);
out.tvdb_episodes = await t.episodes('attack-on-titan');
out.tvdb_cast = await t.cast('attack-on-titan');
const ep = { ...out.tvdb_episodes[1] };
await t.fetchDetail('attack-on-titan', ep);
out.tvdb_detail = ep;

// ---- Wikipedia -------------------------------------------------------------
const w = new WikipediaSource({});
w.pageHtml = async () => fix('wiki_page.html');
const wikiShow = await w.show('List of Attack on Titan episodes');
out.wiki_show = plain(wikiShow);
out.wiki_episodes = await w.episodes('List of Attack on Titan episodes');

// ---- helpers ---------------------------------------------------------------
out.helpers = {
  safe_filename: ['Re:Zero / Season 1', 'CON', 'A  b\tc.', '<bad>|name?', 'x'.repeat(200), '', ':::']
    .map((s) => nfo.safeFilename(s)),
  parse_text_date: ['Jul 7, 2000', 'April 7, 2013', '2013-04-07', 'Sept 2013', '']
    .map(util.parseTextDate),
  parse_date_range: ['Sep 29, 2023 to Mar 22, 2024', 'Apr 7, 2013 to ?', 'Not available']
    .map((s) => util.parseDateRange(s)),
  duration: ['24 min. per ep.', '1 hr. 41 min.', '25 minutes', '30 sec.', 'Unknown']
    .map(util.durationToSeconds),
  rating_token: ['PG-13 - Teens 13 or older', 'R+ - Mild Nudity', 'G', ''].map(util.ratingToken),
  mpaa: ['PG-13', 'r', 'RX', 'Q', ''].map(nfo.mpaaFromToken),
  flip_name: ['Ichinose, Kana', 'Cher', 'A, B, C'].map(util.flipName),
  strip_tags: ['<b>a</b>&amp;<i>b</i>', 'x&nbsp;y', '&#x27;q&#x27;'].map((s) => util.stripTags(s)),
  strip_tags_breaks: ['<p>one</p><p>two</p>', 'a<br>b<br/>c'].map((s) => util.stripTags(s, true)),
  full_image_url: ['https://cdn.myanimelist.net/r/200x300/images/a.jpg?s=1', 'https://x/y.webp']
    .map(util.fullImageUrl),
  poster_candidates: ['https://x/y.webp', 'https://x/y.jpg', ''].map(nfo.posterCandidates),
  iso_date: ['2013-04-07T00:00', 'bad', ''].map(nfo.isoDate),
  split_alt_title: ['Romaji (Japanese)', 'Only Romaji', '', 'A (B) (C)'].map(mal.splitAltTitle),
  premiered: ['Fall 2023', '2011', 'nothing'].map(util.parsePremiered),
};

// ---- XML -------------------------------------------------------------------
const opts = { showName: '', preferEnglish: true, tmdbId: '1429',
               extraGenres: ['Custom Genre', 'action'] };
out.xml_tvshow_mal = nfo.renderXml(nfo.buildTvshowXml(malShow, opts, out.mal_cast_ja));
out.xml_season_mal = nfo.renderXml(nfo.buildSeasonXml(malShow, 1));
out.xml_episode_mal = nfo.renderXml(
  nfo.buildEpisodeXml(out.mal_episodes[0], malShow, 'Attack on Titan', 1, 1, false));

const topts = { showName: '', preferEnglish: true };
out.xml_tvshow_tvdb = nfo.renderXml(nfo.buildTvshowXml(tvdbShow, topts, out.tvdb_cast));
out.xml_episode_tvdb = nfo.renderXml(
  nfo.buildEpisodeXml(out.tvdb_episodes[0], tvdbShow, 'Attack on Titan', 0, 20, true));

out.xml_episode_wiki = nfo.renderXml(
  nfo.buildEpisodeXml(out.wiki_episodes[0], wikiShow, 'Attack on Titan', 1, 1, true));

fs.writeFileSync(new URL('./js.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('node ok');
