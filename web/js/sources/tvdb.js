/**
 * TheTVDB — real season/episode numbering, the thing MAL cannot give.
 *
 * Search uses the one unauthenticated JSON endpoint TVDB's own search box
 * calls; everything else is scraped, because the v4 API needs a key.
 */

import { WebClient } from '../http.js';
import {
  CAST_LIMIT, DEMOGRAPHICS, TVDB_BASE, TVDB_SEARCH_URL, Cancelled, ScrapeError, SearchHit, Show,
  durationToSeconds, escapeRegex, findAll, newEpisode, normaliseStatus, parseInt_,
  parseTextDate, stripTags,
} from '../util.js';

/**
 * TVDB hides every translation in the page as
 *   <div class="change_translation_text" data-language="eng" data-title="..."><p>overview</p></div>
 * Anonymous visitors are shown the series' origin language, so for anime the
 * visible title is Japanese and the English one has to be lifted out of here.
 */
export function tvdbTranslation(doc, language = 'eng') {
  const re = new RegExp(
    `data-language="${escapeRegex(language)}"\\s+data-title="([^"]*)"[^>]*>\\s*(?:<p>([\\s\\S]*?)</p>)?`,
  );
  const match = doc.match(re);
  if (!match) return ['', ''];
  return [stripTags(match[1]), stripTags(match[2] || '', true)];
}

/** One <li> of the series sidebar, as raw HTML. */
export function tvdbInfoField(doc, label) {
  const block = doc.match(/id="series_basic_info"([\s\S]*)/);
  const scope = block ? block[1].slice(0, 20000) : doc;
  const re = new RegExp(`<li[^>]*>\\s*<strong>\\s*${escapeRegex(label)}\\s*</strong>([\\s\\S]*?)</li>`);
  const match = scope.match(re);
  return match ? match[1] : '';
}

export function tvdbInfoText(doc, label) {
  return stripTags(tvdbInfoField(doc, label));
}

export function tvdbInfoLinks(doc, label) {
  const fragment = tvdbInfoField(doc, label);
  const names = [];
  const seen = new Set();
  for (const match of findAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g, fragment)) {
    const name = stripTags(match[1]);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  if (!names.length) {
    const text = stripTags(fragment);
    return text ? [text] : [];
  }
  return names;
}

/**
 * Numbered episodes are labelled 'S04E12'; the 'Additional Specials' block uses
 * 'SPECIAL 0x14' instead. Specials map to season 0, which is what Emby expects.
 */
export function parseTvdbEpisodeLabel(item) {
  const normal = item.match(/episode-label">\s*S(\d+)E(\d+)\s*</);
  if (normal) return [Number(normal[1]), Number(normal[2])];
  const special = item.match(/episode-label">\s*SPECIAL\s+(\d+)x(\d+)\s*</i);
  if (special) return [Number(special[1]), Number(special[2])];
  return null;
}

/**
 * TVDB's /allseasons/official page: an <h3> per season, then a <ul> of
 * list-group-item episodes. One request covers every season plus specials.
 */
export function parseTvdbAllSeasons(doc) {
  const episodes = [];
  // Split on the season headings so each chunk has a known fallback season.
  const chunks = doc.split(/<h3[^>]*>\s*<a href="[^"]*\/seasons\/official\/(\d+)"[^>]*>/);
  for (let i = 1; i < chunks.length - 1; i += 2) {
    const fallbackSeason = Number(chunks[i]);
    const body = chunks[i + 1];
    // Prefix match, not an exact class: specials carry extra classes.
    for (const item of body.split('<li class="list-group-item').slice(1)) {
      const link = item.match(/<a href="([^"]*\/episodes\/(\d+))"[^>]*>\s*([\s\S]*?)\s*<\/a>/);
      if (!link) continue;
      const label = parseTvdbEpisodeLabel(item);
      // No S/E label at all: skip rather than invent a number.
      if (label === null) continue;
      const [season, number] = label;

      const meta = item.match(/<ul class="list-inline text-muted">([\s\S]*?)<\/ul>/);
      let aired = '';
      if (meta) {
        const first = meta[1].match(/<li>([\s\S]*?)<\/li>/);
        aired = first ? parseTextDate(first[1]) : '';
      }
      const overview = item.match(/<div class="col-xs-9">\s*<p>([\s\S]*?)<\/p>/);

      episodes.push(
        newEpisode({
          season: season !== null && season !== undefined ? season : fallbackSeason,
          number,
          title: stripTags(link[3]),
          aired,
          url: link[1].startsWith('/') ? `${TVDB_BASE}${link[1]}` : link[1],
          synopsis: overview ? stripTags(overview[1], true) : '',
        }),
      );
    }
  }
  return episodes;
}

/** TVDB series page: the actor tab holds <h3>Name<br><small>as Role</small></h3>. */
export function parseTvdbCast(doc) {
  // Bound on the next people-* tab (crew, guest stars) rather than trying to
  // count closing divs — div nesting here is not something to match on.
  const block = doc.match(/id="people-actor"([\s\S]*?)(?=id="people-|$)/);
  const scope = block ? block[1] : '';
  const rows = [];
  for (const item of scope.split('<div class="thumbnail">').slice(1)) {
    const heading = item.match(/<h3>\s*([\s\S]*?)\s*<\/h3>/);
    if (!heading) continue;
    const inner = heading[1];
    const name = stripTags(inner.split(/<br\s*\/?>/)[0]);
    const roleMatch = inner.match(/<small>\s*(?:as\s+)?([\s\S]*?)\s*<\/small>/);
    const role = roleMatch ? stripTags(roleMatch[1]) : '';
    const thumb = item.match(/data-src="([^"]+)"/);
    if (!name) continue;
    rows.push({ name, role, thumb: thumb ? thumb[1] : '', favorites: 0, main: false });
    if (rows.length >= CAST_LIMIT) break;
  }
  return rows;
}

export class TvdbSource extends WebClient {
  static key = 'tvdb';
  static label = 'TheTVDB';
  static hasSeasons = true;
  static refHint = 'TVDB slug or thetvdb.com/series/... URL';

  get key() { return TvdbSource.key; }
  get label() { return TvdbSource.label; }
  get hasSeasons() { return TvdbSource.hasSeasons; }

  static parseRef(text) {
    const value = (text || '').trim();
    const match = value.match(/thetvdb\.com\/series\/([^/?#]+)/i);
    if (match) return match[1];
    if (value && !value.startsWith('http') && !value.includes('/')) return value;
    return '';
  }

  async search(term, limit = 20) {
    const payload = { requests: [{ indexName: 'TVDB', params: { query: term } }] };
    const data = await this.postJson(TVDB_SEARCH_URL, payload);
    const results = (data && data.results) || [];
    const rawHits = results.length ? results[0].hits || [] : [];
    const series = rawHits.filter((h) => (h.type || '') === 'series');
    // Relevance puts movies and lists first; popularity is a better guide.
    series.sort((a, b) => (b.follower_count || 0) - (a.follower_count || 0));

    const hits = [];
    for (const hit of series.slice(0, limit)) {
      const ref = hit.slug || String(hit.tvdb_id || hit.id || '');
      if (!ref) continue;
      let name = stripTags(hit.name || '');
      const english = (hit.translations || {}).eng;
      if (english && hit.primary_language !== 'eng') name = stripTags(english);
      hits.push(
        new SearchHit({
          ref,
          title: name || ref,
          source: this.key,
          mediaType: 'SERIES',
          year: String(hit.year || ''),
          extra: stripTags(hit.network || ''),
        }),
      );
    }
    return hits;
  }

  async show(ref) {
    const doc = await this.get(`${TVDB_BASE}/series/${encodeURIComponent(ref)}`);
    const [englishTitle, englishOverview] = tvdbTranslation(doc, 'eng');
    const visible =
      doc.match(/<h1[^>]*class="translated_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/) ||
      doc.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const original = visible ? stripTags(visible[1]) : '';
    if (!(original || englishTitle)) {
      throw new ScrapeError(`Could not read a title from TVDB's page for '${ref}'.`);
    }

    const [japaneseTitle, japaneseOverview] = tvdbTranslation(doc, 'jpn');

    const firstAired = parseTextDate(tvdbInfoText(doc, 'First Aired'));
    const recent = parseTextDate(tvdbInfoText(doc, 'Recent'));
    const status = normaliseStatus(tvdbInfoText(doc, 'Status'));

    let genres = tvdbInfoLinks(doc, 'Genres').filter((g) => g.toLowerCase() !== 'anime');
    const demographics = genres.filter((g) => DEMOGRAPHICS.has(g.toLowerCase()));
    genres = genres.filter((g) => !DEMOGRAPHICS.has(g.toLowerCase()));

    // Two artwork layouts are in the wild: legacy /banners/posters/<id>-N.jpg
    // and v4 /banners/v4/series/<id>/posters/<hash>.jpg. Anchoring on
    // "posters" (not "actor/photo") keeps cast headshots out of this.
    const posterMatch = doc.match(
      /(https:\/\/artworks\.thetvdb\.com\/banners\/(?:v4\/series\/\d+\/)?(?:posters|series)\/[^"\s]+)/,
    );
    const poster = posterMatch ? posterMatch[1] : '';

    const tvdbId = parseInt_(tvdbInfoText(doc, 'TheTVDB.com Series ID'));
    const imdb = doc.match(/href="https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d+)/);
    const tmdb = doc.match(/href="https?:\/\/(?:www\.)?themoviedb\.org\/tv\/(\d+)/);

    return new Show({
      ref: String(ref),
      source: this.key,
      url: `${TVDB_BASE}/series/${ref}`,
      title: original || englishTitle,
      title_english: englishTitle,
      title_japanese: japaneseTitle !== englishTitle ? japaneseTitle : '',
      media_type: 'TV',
      episode_count: null,
      status,
      aired_from: firstAired,
      aired_to: status === 'ended' ? recent : '',
      duration_seconds: durationToSeconds(tvdbInfoText(doc, 'Average Runtime')),
      rating_token: '',
      synopsis: englishOverview || japaneseOverview,
      year: firstAired ? Number(firstAired.slice(0, 4)) : null,
      studios: tvdbInfoLinks(doc, 'Studio').length
        ? tvdbInfoLinks(doc, 'Studio')
        : tvdbInfoLinks(doc, 'Production Company'),
      networks: tvdbInfoLinks(doc, 'Network'),
      genres,
      demographics,
      poster,
      tvdb_id: tvdbId ? String(tvdbId) : '',
      imdb_id: imdb ? imdb[1] : '',
      tmdb_id: tmdb ? tmdb[1] : '',
    });
  }

  async episodes(ref, onPage = null) {
    const doc = await this.get(`${TVDB_BASE}/series/${encodeURIComponent(ref)}/allseasons/official`);
    const episodes = parseTvdbAllSeasons(doc);
    if (onPage) onPage(1, 1, episodes.length);
    episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || a.number - b.number);
    return episodes;
  }

  /**
   * TVDB shows anonymous visitors the origin-language title, so this is where
   * English titles come from, not just the English overview. The original
   * title is kept as originaltitle rather than thrown away.
   */
  async fetchDetail(ref, episode) {
    if (!episode.url) return;
    let title = '';
    let overview = '';
    try {
      [title, overview] = tvdbTranslation(await this.get(episode.url, 2), 'eng');
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      return;
    }
    if (title) {
      if (episode.title && episode.title !== title && !episode.title_japanese) {
        episode.title_japanese = episode.title;
      }
      episode.title = title;
    }
    if (overview) episode.synopsis = overview;
  }

  async cast(ref) {
    try {
      return parseTvdbCast(await this.get(`${TVDB_BASE}/series/${encodeURIComponent(ref)}`));
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      return [];
    }
  }
}
