/** MyAnimeList — richest anime metadata, but no season numbering. */

import { WebClient } from '../http.js';
import {
  CAST_LIMIT, MAL_BASE, MAL_EPISODE_PAGE_SIZE, Cancelled, ScrapeError, SearchHit, Show,
  cleanText, escapeRegex, findAll, flipName, fullImageUrl, newEpisode, normaliseStatus,
  parseDateRange, parseInt_, parsePremiered, parseTextDate, ratingToken, stripTags,
  durationToSeconds,
} from '../util.js';

/** One sidebar field's raw HTML, scoped so it cannot bleed into the next. */
export function malSidebarFragment(doc, ...labels) {
  for (const label of labels) {
    const re = new RegExp(
      `<span class="dark_text">\\s*${escapeRegex(label)}:\\s*</span>([\\s\\S]*?)` +
        '(?=<span class="dark_text">|</div>)',
    );
    const match = doc.match(re);
    if (match) return match[1];
  }
  return '';
}

export function malSidebarText(doc, ...labels) {
  return stripTags(malSidebarFragment(doc, ...labels));
}

export function malSidebarLinks(doc, ...labels) {
  const fragment = malSidebarFragment(doc, ...labels);
  const names = [];
  const seen = new Set();
  for (const match of findAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g, fragment)) {
    const name = stripTags(match[1]);
    const key = name.toLowerCase();
    if (name && !seen.has(key) && key !== 'add some') {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

const MAL_ROW_RE = /<tr class="episode-list-data">([\s\S]*?)<\/tr>/g;
const MAL_NUM_RE = /class="episode-number[^"]*"[^>]*data-raw="(\d+)"/;
const MAL_LINK_RE = /class="episode-title[^"]*">\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
const MAL_ALT_RE = /<span class="di-ib">([\s\S]*?)<\/span>/;
const MAL_AIRED_RE = /class="episode-aired[^"]*">([^<]*)</;
// Anchored to episode-poll: episode-forum carries a data-raw reply count too.
const MAL_SCORE_RE = /class="episode-poll[^"]*"[^>]*data-raw="([\d.]+)"/;
const MAL_OFFSET_RE = /\?offset=(\d+)/g;

/** MAL's secondary title cell reads 'Romaji (Japanese)'. */
export function splitAltTitle(text) {
  const plain = stripTags(text);
  if (!plain) return ['', ''];
  const match = plain.match(/^([\s\S]*?)\s*\(([^()]*)\)\s*$/);
  if (match && match[2].trim()) return [match[1].trim(), match[2].trim()];
  return [plain, ''];
}

export function parseMalEpisodeRows(doc, ref) {
  const episodes = [];
  let index = 0;
  for (const rowMatch of findAll(MAL_ROW_RE, doc)) {
    index += 1;
    const block = rowMatch[1];
    const number = block.match(MAL_NUM_RE);
    const link = block.match(MAL_LINK_RE);
    const aired = block.match(MAL_AIRED_RE);
    const score = block.match(MAL_SCORE_RE);
    const alt = block.match(MAL_ALT_RE);
    const [romaji, japanese] = splitAltTitle(alt ? alt[1] : '');
    episodes.push(
      newEpisode({
        number: number ? Number(number[1]) : index,
        url: link ? stripTags(link[1]) : `${MAL_BASE}/anime/${ref}`,
        title: link ? stripTags(link[2]) : '',
        title_japanese: japanese,
        title_romaji: romaji,
        aired: aired ? parseTextDate(aired[1]) : '',
        score: score ? Number(score[1]) : null,
      }),
    );
  }
  return episodes;
}

/**
 * Flatten MAL's character table into actor rows for one dub language.
 * Falls back to the Japanese cast when the requested language is absent.
 */
export function parseMalCharacters(doc, language) {
  const rows = [];
  const blocks = doc.split('class="js-anime-character-table"').slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/<h3 class="h3_character_name">([\s\S]*?)<\/h3>/);
    if (!nameMatch) continue;
    const charName = stripTags(nameMatch[1]);
    if (!charName) continue;

    const favMatch =
      block.match(/class="js-anime-character-favorites"[^>]*>\s*([\d,]+)/) ||
      block.match(/([\d,]+)\s+Favorites/);
    const favourites = favMatch ? parseInt_(favMatch[1]) : 0;
    const isMain = /<div class="spaceit_pad">\s*Main/.test(block);

    const vaArea = block.split('class="js-anime-character-va"');
    const candidates = [];
    if (vaArea.length > 1) {
      for (const vaRow of vaArea[1].split('class="js-anime-character-va-lang"').slice(1)) {
        const person = vaRow.match(/href="[^"]*\/people\/\d+\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
        if (!person) continue;
        const lang = vaRow.match(/js-anime-character-language"[^>]*>\s*([^<]+)/);
        const thumb = vaRow.match(/data-src="([^"]*voiceactors[^"]*)"/);
        candidates.push({
          name: flipName(stripTags(person[1])),
          language: lang ? stripTags(lang[1]) : '',
          thumb: thumb ? fullImageUrl(thumb[1]) : '',
        });
      }
    }
    if (!candidates.length) continue;

    let picked = candidates.find((c) => c.language === language) || null;
    if (picked === null && language !== 'Japanese') {
      picked = candidates.find((c) => c.language === 'Japanese') || null;
    }
    if (picked === null || !picked.name) continue;

    rows.push({
      name: picked.name,
      role: charName,
      thumb: picked.thumb,
      favorites: favourites || 0,
      main: isMain,
    });
  }

  rows.sort((a, b) => {
    if (a.main !== b.main) return a.main ? -1 : 1;
    if (a.favorites !== b.favorites) return b.favorites - a.favorites;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return rows.slice(0, CAST_LIMIT);
}

export function parseMalEpisodeSynopsis(doc) {
  const match = doc.match(/<h2[^>]*>\s*Synopsis\s*<\/h2>([\s\S]*?)(?:<\/div>|<h2)/);
  if (!match) return '';
  const text = stripTags(match[1], true);
  if (/^no synopsis/i.test(text)) return '';
  return text;
}

export class MalSource extends WebClient {
  static key = 'mal';
  static label = 'MyAnimeList';
  static hasSeasons = false;
  static refHint = 'MAL anime ID or myanimelist.net URL';

  get key() { return MalSource.key; }
  get label() { return MalSource.label; }
  get hasSeasons() { return MalSource.hasSeasons; }

  static parseRef(text) {
    const value = (text || '').trim();
    if (/^\d+$/.test(value)) return value;
    const match = value.match(/myanimelist\.net\/anime\/(\d+)/i);
    return match ? match[1] : '';
  }

  async search(term, limit = 20) {
    const doc = await this.get(
      `${MAL_BASE}/anime.php?${new URLSearchParams({ q: term, cat: 'anime' })}`,
    );
    const hits = [];
    const seen = new Set();
    for (const block of doc.split('<tr>').slice(1)) {
      const link = block.match(/href="https:\/\/myanimelist\.net\/anime\/(\d+)\/[^"]*"/);
      if (!link) continue;
      const ref = link[1];
      if (seen.has(ref)) continue;
      const titleMatch =
        block.match(/class="hoverinfo_trigger[^"]*"[^>]*>\s*<strong>([\s\S]*?)<\/strong>/) ||
        block.match(/<strong>([\s\S]*?)<\/strong>/);
      if (!titleMatch) continue;
      const cells = findAll(
        /<td[^>]*class="borderClass ac bgColor\d"[^>]*>([\s\S]*?)<\/td>/g,
        block,
      ).map((m) => stripTags(m[1]));
      seen.add(ref);
      const score = cells.length > 2 ? cells[2] : '';
      hits.push(
        new SearchHit({
          ref,
          title: stripTags(titleMatch[1]),
          source: this.key,
          mediaType: (cells.length ? cells[0] : '').toUpperCase(),
          episodeCount: cells.length > 1 ? parseInt_(cells[1]) : null,
          extra: score && score !== 'N/A' ? `score ${score}` : '',
        }),
      );
      if (hits.length >= limit) break;
    }
    return hits;
  }

  async show(ref) {
    const doc = await this.get(`${MAL_BASE}/anime/${ref}`);
    const titleMatch =
      doc.match(/<h1[^>]*class="title-name[^"]*"[^>]*>([\s\S]*?)<\/h1>/) ||
      doc.match(/<meta property="og:title" content="([^"]*)"/);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';
    if (!title) {
      throw new ScrapeError(
        `Could not read a title from MAL's page for anime ${ref}. MAL may have changed its layout.`,
      );
    }

    let english = malSidebarText(doc, 'English');
    if (!english) {
      const match = doc.match(/<p class="title-english[^"]*">([\s\S]*?)<\/p>/);
      english = match ? stripTags(match[1]) : '';
    }

    const [airedFrom, airedTo] = parseDateRange(malSidebarText(doc, 'Aired'));
    let [season, year] = parsePremiered(malSidebarText(doc, 'Premiered'));
    if (year === null && airedFrom) year = Number(airedFrom.slice(0, 4));

    const synopsisMatch = doc.match(/<p itemprop="description">([\s\S]*?)<\/p>/);
    const synopsis = synopsisMatch ? cleanText(stripTags(synopsisMatch[1], true)) : '';

    const scoreMatch = doc.match(/itemprop="ratingValue"[^>]*>([^<]*)</);
    const countMatch = doc.match(/itemprop="ratingCount"[^>]*>([^<]*)</);
    let score = null;
    if (scoreMatch) {
      const parsed = Number(stripTags(scoreMatch[1]));
      score = Number.isFinite(parsed) ? parsed : null;
    }

    let poster = '';
    for (const tag of findAll(/<img\b[^>]*>/g, doc)) {
      if (tag[0].includes('itemprop="image"')) {
        const src = tag[0].match(/data-src="([^"]+)"/) || tag[0].match(/src="([^"]+)"/);
        if (src) poster = fullImageUrl(src[1]);
        break;
      }
    }

    // MAL embeds PVs via youtube-nocookie.com; normalise to a watch URL.
    let trailer = '';
    const trailerMatch = doc.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{6,})/);
    if (trailerMatch) trailer = `https://www.youtube.com/watch?v=${trailerMatch[1]}`;

    return new Show({
      ref: String(ref),
      source: this.key,
      url: `${MAL_BASE}/anime/${ref}`,
      title,
      title_english: english,
      title_japanese: malSidebarText(doc, 'Japanese'),
      synonyms: malSidebarText(doc, 'Synonyms').split(',').map((s) => s.trim()).filter(Boolean),
      media_type: malSidebarText(doc, 'Type').toUpperCase(),
      source_material: malSidebarText(doc, 'Source'),
      episode_count: parseInt_(malSidebarText(doc, 'Episodes')),
      status: normaliseStatus(malSidebarText(doc, 'Status')),
      aired_from: airedFrom,
      aired_to: airedTo,
      duration_seconds: durationToSeconds(malSidebarText(doc, 'Duration')),
      rating_token: ratingToken(malSidebarText(doc, 'Rating')),
      score,
      scored_by: countMatch ? parseInt_(countMatch[1]) : null,
      synopsis,
      season,
      year,
      studios: malSidebarLinks(doc, 'Studios', 'Studio'),
      networks: [],
      genres: [
        ...malSidebarLinks(doc, 'Genres', 'Genre'),
        ...malSidebarLinks(doc, 'Themes', 'Theme'),
      ],
      demographics: malSidebarLinks(doc, 'Demographics', 'Demographic'),
      poster,
      trailer,
    });
  }

  async episodes(ref, onPage = null) {
    const episodes = [];
    const seen = new Set();
    let offset = 0;
    let lastPage = null;

    for (;;) {
      this.checkCancelled();
      const doc = await this.get(`${MAL_BASE}/anime/${ref}/_/episode?offset=${offset}`);
      const rows = parseMalEpisodeRows(doc, ref);
      const fresh = rows.filter((r) => !seen.has(r.number));
      for (const row of fresh) seen.add(row.number);
      episodes.push(...fresh);

      if (lastPage === null) {
        const offsets = findAll(MAL_OFFSET_RE, doc).map((m) => Number(m[1]));
        const highest = offsets.length ? Math.max(...offsets) : 0;
        lastPage = Math.floor(highest / MAL_EPISODE_PAGE_SIZE) + 1;
      }
      const page = Math.floor(offset / MAL_EPISODE_PAGE_SIZE) + 1;
      if (onPage) onPage(page, Math.max(lastPage, page), episodes.length);

      if (!fresh.length || rows.length < MAL_EPISODE_PAGE_SIZE) break;
      offset += MAL_EPISODE_PAGE_SIZE;
      if (offset > 20000) break; // guard against a pagination loop
    }

    episodes.sort((a, b) => a.number - b.number);
    return episodes;
  }

  /** Pull this episode's plot from its own MAL page. */
  async fetchDetail(ref, episode) {
    let doc;
    try {
      doc = await this.get(`${MAL_BASE}/anime/${ref}/_/episode/${episode.number}`, 2);
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      return;
    }
    const synopsis = parseMalEpisodeSynopsis(doc);
    if (synopsis) episode.synopsis = synopsis;
  }

  async cast(ref, language = 'Japanese') {
    try {
      return parseMalCharacters(await this.get(`${MAL_BASE}/anime/${ref}/_/characters`), language);
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      return [];
    }
  }
}
