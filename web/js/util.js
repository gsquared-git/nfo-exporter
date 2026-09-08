/**
 * Text helpers — a direct port of the module-level functions in sources.py.
 *
 * The Python original parses these pages with regular expressions rather than a
 * DOM, and the expressions are tuned to each site's markup (MAL's sidebar
 * scoping, TVDB's translation blocks, Wikipedia's Template:Episode list rows).
 * They are ported literally so the output matches the desktop tool, with
 * Python's re.S rendered as [\s\S] and re.escape as escapeRegex.
 */

export const APP_VERSION = '3.0-web';

export const MAL_BASE = 'https://myanimelist.net';
export const TVDB_BASE = 'https://thetvdb.com';
export const TVDB_SEARCH_URL = 'https://api4.thetvdb.com/web/search/queries';
export const WIKI_API = 'https://en.wikipedia.org/w/api.php';

export const SOURCES = { mal: 'MyAnimeList', tvdb: 'TheTVDB', wikipedia: 'Wikipedia' };

export const MAL_EPISODE_PAGE_SIZE = 100;
export const CAST_LIMIT = 30;

export const DEMOGRAPHICS = new Set(['shounen', 'shoujo', 'seinen', 'josei', 'kids']);

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const TAG_RE = /<[^>]+>/g;
const MAL_FOOTER_RE = /\s*\[Written by MAL Rewrite\]\s*$/i;
const ILLEGAL_XML_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

export class Cancelled extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'Cancelled';
  }
}

export class ScrapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScrapeError';
  }
}

export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Decode HTML entities. RCDATA parsing in a detached textarea: entities are
 *  resolved, markup is not, and nothing is ever inserted into the document. */
let entityBox = null;
export function unescapeHtml(text) {
  if (!text) return '';
  if (!text.includes('&')) return text;
  if (!entityBox) entityBox = document.createElement('textarea');
  entityBox.innerHTML = text;
  return entityBox.value;
}

export function cleanText(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  text = text.replace(MAL_FOOTER_RE, '');
  return text.replace(ILLEGAL_XML_RE, '');
}

/** HTML fragment -> plain text, entities resolved, nbsp normalised. */
export function stripTags(fragment, keepBreaks = false) {
  let text = fragment || '';
  if (keepBreaks) {
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n\n');
  }
  text = text.replace(TAG_RE, '');
  text = unescapeHtml(text).replace(/\u00A0/g, ' ');
  if (keepBreaks) {
    text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n');
    return text.split('\n').map((line) => line.trim()).join('\n').trim();
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** 'Ichinose, Kana' -> 'Kana Ichinose'. Left alone if not 'Surname, Given'. */
export function flipName(name) {
  const text = cleanText(name);
  if ((text.match(/,/g) || []).length === 1) {
    const [last, first] = text.split(',').map((part) => part.trim());
    if (last && first) return `${first} ${last}`;
  }
  return text;
}

/** 'Jul 7, 2000' / 'April 7, 2013' -> '2000-07-07'. Partial dates -> ''. */
export function parseTextDate(text) {
  const plain = stripTags(text);
  const iso = plain.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const match = plain.match(/([A-Za-z]{3})[a-z.]*\s+(\d{1,2}),?\s*(\d{4})/);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    if (month) {
      return `${String(Number(match[3])).padStart(4, '0')}-` +
        `${String(month).padStart(2, '0')}-` +
        `${String(Number(match[2])).padStart(2, '0')}`;
    }
  }
  return '';
}

/** 'Sep 29, 2023 to Mar 22, 2024' -> ['2023-09-29', '2024-03-22']. */
export function parseDateRange(text) {
  const plain = stripTags(text);
  if (!plain || plain.toLowerCase().startsWith('not available')) return ['', ''];
  const split = plain.match(/^([\s\S]*?)\s+to\s+([\s\S]*)$/);
  if (!split) return [parseTextDate(plain), ''];
  return [parseTextDate(split[1]), parseTextDate(split[2])];
}

/** 'Fall 2023' -> ['fall', 2023]. */
export function parsePremiered(text) {
  const plain = stripTags(text);
  const match = plain.match(/(Winter|Spring|Summer|Fall)\s+(\d{4})/i);
  if (match) return [match[1].toLowerCase(), Number(match[2])];
  const year = plain.match(/(\d{4})/);
  return ['', year ? Number(year[1]) : null];
}

/** '24 min. per ep.' -> 1440; '1 hr. 41 min.' -> 6060. */
export function durationToSeconds(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'number') {
    return text > 0 && text < 600 ? text * 60 : text || null;
  }
  const lowered = stripTags(text).toLowerCase();
  const hours = lowered.match(/(\d+)\s*hr/);
  const minutes = lowered.match(/(\d+)\s*min/);
  const seconds = lowered.match(/(\d+)\s*sec/);
  const total =
    (hours ? Number(hours[1]) * 3600 : 0) +
    (minutes ? Number(minutes[1]) * 60 : 0) +
    (seconds ? Number(seconds[1]) : 0);
  return total || null;
}

export function parseInt_(text) {
  if (typeof text === 'number') return Math.trunc(text);
  const digits = (stripTags(text) || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

export function normaliseStatus(status) {
  return stripTags(String(status ?? '')).replace(/_/g, ' ').trim().toLowerCase();
}

/** 'PG-13 - Teens 13 or older' -> 'PG-13'. Splits on ' - ', not '-'. */
export function ratingToken(rating) {
  const text = stripTags(rating);
  if (!text) return '';
  const match = text.match(/^([\s\S]*?)\s+-\s+/);
  return (match ? match[1] : text).trim();
}

/** Strip MAL's /r/<W>x<H>/ resize segment and any cache-busting query. */
export function fullImageUrl(url) {
  const base = cleanText(url).split('?')[0];
  return base.replace(/\/r\/\d+x\d+\//, '/');
}

/** A uniform episode record, so every source yields the same shape. */
export function newEpisode(values = {}) {
  return {
    season: null,
    number: 0,
    title: '',
    title_japanese: '',
    title_romaji: '',
    aired: '',
    score: null,
    synopsis: '',
    url: '',
    director: '',
    writer: '',
    runtime: null,
    ...values,
  };
}

/** Python's str.strip(chars) — trim any of `chars` from both ends. */
export function stripChars(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** All matches of a global regex, as an array of match arrays. */
export function findAll(pattern, text) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  return [...String(text || '').matchAll(re)];
}

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Cancelled());
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Cancelled());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// --------------------------------------------------------------------------- //
// Models
// --------------------------------------------------------------------------- //

export class SearchHit {
  constructor({ ref, title, source = '', mediaType = '', year = '', episodeCount = null, extra = '' }) {
    this.ref = ref;
    this.title = title;
    this.source = source;
    this.mediaType = mediaType;
    this.year = year;
    this.episodeCount = episodeCount;
    this.extra = extra;
  }

  describe() {
    const bits = [
      this.mediaType,
      this.year,
      this.episodeCount ? `${this.episodeCount} eps` : '',
      this.extra,
    ].filter(Boolean);
    return bits.length ? `${this.title}  [${bits.join(', ')}]` : this.title;
  }
}

export class Show {
  constructor(values = {}) {
    Object.assign(
      this,
      {
        ref: '',
        source: '',
        url: '',
        title: '',
        title_english: '',
        title_japanese: '',
        synonyms: [],
        media_type: '',
        source_material: '',
        episode_count: null,
        status: '',
        aired_from: '',
        aired_to: '',
        duration_seconds: null,
        rating_token: '',
        score: null,
        scored_by: null,
        synopsis: '',
        season: '',
        year: null,
        studios: [],
        networks: [],
        genres: [],
        demographics: [],
        poster: '',
        trailer: '',
        tvdb_id: '',
        imdb_id: '',
        tmdb_id: '',
      },
      values,
    );
  }

  displayTitle(preferEnglish = true) {
    if (preferEnglish && this.title_english) return this.title_english;
    return this.title || this.title_english || 'Unknown Show';
  }

  get displayYear() {
    if (this.year) return String(this.year);
    return this.aired_from ? this.aired_from.slice(0, 4) : '';
  }

  get runtimeMinutes() {
    const value = Number(this.duration_seconds);
    if (!Number.isFinite(value)) return '';
    return value >= 60 ? String(Math.floor(value / 60)) : '';
  }
}
