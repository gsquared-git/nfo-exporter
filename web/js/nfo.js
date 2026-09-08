/**
 * NFO document construction — a port of the XML half of nfo_exporter.py.
 *
 * The element tree and serializer below reproduce what Python's
 * xml.etree.ElementTree produces after ET.indent(root, space="  "): leaf
 * elements stay on one line, containers indent their children by two spaces,
 * and text is escaped for &, < and > only. Byte-identical output against the
 * desktop tool is the point — Emby libraries built by one should be
 * indistinguishable from the other.
 */

import { cleanText, pad2 } from './util.js';

// Age-rating token -> Emby/Kodi <mpaa> value.
export const MPAA_MAP = {
  G: 'TV-G',
  PG: 'TV-Y7',
  'PG-13': 'TV-14',
  R: 'TV-MA',
  'R+': 'TV-MA',
  RX: 'TV-MA',
};

// Normalised airing status -> Emby <status> value.
export const STATUS_MAP = {
  'finished airing': 'Ended',
  ended: 'Ended',
  completed: 'Ended',
  'currently airing': 'Continuing',
  continuing: 'Continuing',
  'not yet aired': 'Continuing',
  upcoming: 'Continuing',
};

export const CAST_LANGUAGES = [
  'Japanese', 'English', 'German', 'Spanish', 'French',
  'Italian', 'Portuguese (BR)', 'Korean', 'Mandarin', 'Hungarian',
];

const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

// --------------------------------------------------------------------------- //
// Element tree
// --------------------------------------------------------------------------- //

class Element {
  constructor(tag, attrs = {}) {
    this.tag = tag;
    this.attrs = attrs;
    this.text = null;
    this.children = [];
  }
}

export function element(tag, attrs = {}) {
  return new Element(tag, attrs);
}

export function subElement(parent, tag, attrs = {}) {
  const node = new Element(tag, attrs);
  parent.children.push(node);
  return node;
}

/** Append <tag>text</tag> only when there is actually text to write. */
export function sub(parent, tag, text, attrs = {}) {
  const value = cleanText(text);
  if (!value) return null;
  const node = subElement(parent, tag, Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [k, String(v)]),
  ));
  node.text = value;
  return node;
}

function escapeCdata(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttrib(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#09;');
}

function serialize(node, level = 0) {
  const padding = '  '.repeat(level);
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => ` ${key}="${escapeAttrib(value)}"`)
    .join('');

  if (node.children.length) {
    const inner = node.children.map((child) => serialize(child, level + 1)).join('\n');
    return `${padding}<${node.tag}${attrs}>\n${inner}\n${padding}</${node.tag}>`;
  }
  if (node.text !== null && node.text !== '') {
    return `${padding}<${node.tag}${attrs}>${escapeCdata(node.text)}</${node.tag}>`;
  }
  return `${padding}<${node.tag}${attrs} />`;
}

/** A complete, indented, UTF-8 NFO document as a string. */
export function renderXml(root) {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n${serialize(root, 0)}\n`;
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

/** Make a string safe as a single Windows path component. */
export function safeFilename(name, fallback = 'Untitled') {
  let value = cleanText(name);
  value = value.replace(/:/g, ' -').replace(/\//g, '-').replace(/\\/g, '-');
  value = value.replace(/[<>"|?*]/g, '');
  value = value.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (WIN_RESERVED.has(value.toUpperCase())) value = `_${value}`;
  return value.slice(0, 120).trim() || fallback;
}

export function isoDate(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

export function mpaaFromToken(token) {
  return MPAA_MAP[String(token || '').trim().toUpperCase()] || '';
}

/**
 * Prefer a .jpg over a .webp: MAL's CDN serves both for the same image, and
 * folder.jpg is the safest thing to put in front of Emby.
 */
export function posterCandidates(url) {
  if (!url) return [];
  if (url.toLowerCase().endsWith('.webp')) return [`${url.slice(0, -5)}.jpg`, url];
  return [url];
}

// --------------------------------------------------------------------------- //
// Builders
// --------------------------------------------------------------------------- //

export function buildTvshowXml(show, options, cast) {
  const root = element('tvshow');
  const title = options.showName || show.displayTitle(options.preferEnglish);

  sub(root, 'title', title);
  sub(root, 'originaltitle', show.title_japanese || show.title);
  sub(root, 'sorttitle', title);
  sub(root, 'plot', show.synopsis);
  sub(root, 'outline', show.synopsis);

  if (show.score) {
    sub(root, 'rating', Number(show.score).toFixed(2));
    // Half-up, not banker's rounding: 9.25 must become 93, not 92.
    sub(root, 'criticrating', Math.floor(Number(show.score) * 10 + 0.5));
  }
  sub(root, 'votes', show.scored_by);

  sub(root, 'mpaa', mpaaFromToken(show.rating_token));
  sub(root, 'premiered', show.aired_from);
  sub(root, 'releasedate', show.aired_from);
  sub(root, 'year', show.displayYear);
  sub(root, 'enddate', show.aired_to);
  sub(root, 'status', STATUS_MAP[show.status] || '');
  sub(root, 'runtime', show.runtimeMinutes);

  for (const studio of show.studios) sub(root, 'studio', studio);
  for (const network of show.networks) sub(root, 'studio', network);

  const seen = new Set();
  for (const raw of [...show.genres, ...(options.extraGenres || [])]) {
    const name = cleanText(raw);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      sub(root, 'genre', name);
    }
  }

  sub(root, 'tag', 'Anime');
  for (const name of show.demographics) sub(root, 'tag', name);
  if (show.season) {
    const capitalised = show.season.charAt(0).toUpperCase() + show.season.slice(1);
    sub(root, 'tag', `${capitalised} ${show.displayYear}`.trim());
  }
  sub(root, 'trailer', show.trailer);

  // Provider IDs are what actually let Emby lock onto the right series.
  // Exactly one uniqueid may carry default="true", and a given type must appear
  // once: writing the TVDB *slug* as type="tvdb" alongside the numeric TVDB id
  // would be two contradictory values for the same provider.
  const providerIds = [];
  for (const key of ['tvdb', 'tmdb', 'imdb', 'anidb']) {
    const value = options[`${key}Id`] || show[`${key}_id`] || '';
    if (value) providerIds.push([key, value]);
  }

  const sourceType = show.source || 'source';
  let defaultUsed = false;
  if (!providerIds.some(([key]) => key === sourceType)) {
    sub(root, 'uniqueid', show.ref, { type: sourceType, default: 'true' });
    defaultUsed = true;
    if (show.source === 'mal') sub(root, 'malid', show.ref);
  }
  for (const [key, value] of providerIds) {
    const attrs = { type: key };
    if (!defaultUsed) {
      attrs.default = 'true';
      defaultUsed = true;
    }
    sub(root, 'uniqueid', value, attrs);
    sub(root, `${key}id`, value);
  }
  sub(root, 'sourceurl', show.url);

  cast.forEach((actor, index) => {
    const node = subElement(root, 'actor');
    sub(node, 'name', actor.name);
    sub(node, 'role', actor.role);
    sub(node, 'type', 'Actor');
    sub(node, 'sortorder', index);
    sub(node, 'thumb', actor.thumb);
  });

  if (show.poster) {
    const art = subElement(root, 'art');
    sub(art, 'poster', show.poster);
  }

  return root;
}

export function buildSeasonXml(show, season) {
  const root = element('season');
  sub(root, 'title', season === 0 ? 'Specials' : `Season ${season}`);
  sub(root, 'seasonnumber', season);
  sub(root, 'plot', show.synopsis);
  sub(root, 'premiered', show.aired_from);
  sub(root, 'year', show.displayYear);
  sub(root, 'uniqueid', show.ref, { type: show.source || 'source', default: 'true' });
  if (show.poster) {
    const art = subElement(root, 'art');
    sub(art, 'poster', show.poster);
  }
  return root;
}

export function buildEpisodeXml(episode, show, showTitle, season, episodeNumber, hasSeasons) {
  const root = element('episodedetails');

  sub(root, 'title', episode.title || `Episode ${episodeNumber}`);
  sub(root, 'originaltitle', episode.title_japanese);
  sub(root, 'showtitle', showTitle);
  sub(root, 'season', season);
  sub(root, 'episode', episodeNumber);
  sub(root, 'displayseason', season);
  sub(root, 'displayepisode', episodeNumber);

  const aired = isoDate(episode.aired);
  sub(root, 'aired', aired);
  if (aired) sub(root, 'year', aired.slice(0, 4));

  sub(root, 'plot', episode.synopsis);

  if (episode.score) sub(root, 'rating', Number(episode.score).toFixed(2));

  sub(root, 'runtime', episode.runtime ? String(episode.runtime) : show.runtimeMinutes);
  sub(root, 'mpaa', mpaaFromToken(show.rating_token));

  for (const person of (episode.director || '').split(',').map((p) => p.trim()).filter(Boolean)) {
    sub(root, 'director', person);
  }
  for (const person of (episode.writer || '').split(',').map((p) => p.trim()).filter(Boolean)) {
    sub(root, 'credits', person);
  }

  for (const studio of show.studios) sub(root, 'studio', studio);

  const number = episode.number;
  if (number !== null && number !== undefined) {
    // Namespaced type: a composite like "attack-on-titan-1x1" is not a real
    // provider episode id, and writing it as type="tvdb" would mislead Emby.
    const ident = hasSeasons ? `${show.ref}-${season}x${number}` : `${show.ref}-${number}`;
    sub(root, 'uniqueid', ident, { type: `${show.source || 'source'}episode` });
    sub(root, 'sourceepisodenumber', number);
  }
  sub(root, 'sourceurl', episode.url);

  return root;
}

export function seasonFolderName(season) {
  return `Season ${pad2(season)}`;
}
