/**
 * en.wikipedia.org episode lists. Adds directors and writers, and carries
 * machine-readable ISO air dates. Has little series-level metadata, so the
 * show details it returns are deliberately sparse.
 *
 * This is the one source that needs no proxy: the MediaWiki API sets
 * Access-Control-Allow-Origin itself when called with origin=*.
 */

import { WebClient } from '../http.js';
import {
  WIKI_API, ScrapeError, SearchHit, Show,
  findAll, newEpisode, parseInt_, parseTextDate, stripChars, stripTags,
} from '../util.js';

/**
 * Pull the plot out of an episode's summary row:
 *   <tr class="expand-child"><td class="description">
 *     <div class="shortSummaryText">...</div>
 * Citation superscripts are dropped so plots do not read '...Oxnard.[2] Both...'.
 */
export function wikiSummary(rowHtml) {
  const match =
    rowHtml.match(/class="description"[^>]*>([\s\S]*?)<\/td>/) ||
    rowHtml.match(/class="shortSummaryText"[^>]*>([\s\S]*)/);
  if (!match) return '';
  const fragment = match[1].replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '');
  const text = stripTags(fragment, true);
  return text.replace(/\s*\[\d+\]/g, '').trim();
}

/**
 * Wikipedia stacks multiple credits with <br>, and cells often already end in a
 * comma. Split on commas, drop the blanks, rejoin cleanly.
 */
export function wikiPeople(fragment) {
  const text = stripTags((fragment || '').replace(/<br\s*\/?>/gi, ','));
  return text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Wikipedia episode lists use Template:Episode list, which renders rows as
 * <tr class="vevent module-episode-list-row">. Columns vary between articles,
 * so the header row is read first and cells are mapped by header name rather
 * than by position.
 */
export function parseWikiEpisodeTables(html) {
  const episodes = [];
  // Season number comes from the h3 heading that precedes each table. The h2
  // level matters too: these articles often carry a *different* work further
  // down (a spin-off ONA with its own "Part 1/2/3" tables) plus Home media and
  // References sections. Merging those into the main series' seasons would
  // silently mis-number episodes, so only episode-ish h2 sections are read.
  const pieces = html.split(/(<h[23][^>]*>[\s\S]*?<\/h[23]>)/);
  let currentSeason = null;
  let fallbackSeason = 0;
  let sectionOk = true;

  for (const piece of pieces) {
    if (piece === undefined) continue;
    const heading = piece.match(/^<h([23])[^>]*>([\s\S]*?)<\/h[23]>/);
    if (heading) {
      const level = heading[1];
      const text = stripTags(heading[2]);
      if (level === '2') {
        sectionOk = /episode|season|series overview/i.test(text);
        currentSeason = null;
        fallbackSeason = 0;
      }
      const match = text.match(/(?:season|series|part|cour)\s+(\d+)/i);
      currentSeason = match ? Number(match[1]) : null;
      continue;
    }
    if (!sectionOk) continue;

    for (const tableMatch of findAll(/<table[^>]*>([\s\S]*?)<\/table>/g, piece)) {
      const table = tableMatch[1];
      if (!table.includes('module-episode-list-row')) continue;

      const headers = findAll(/<th[^>]*scope="col"[^>]*>([\s\S]*?)<\/th>/g, table).map((m) =>
        stripTags(m[1]).toLowerCase(),
      );

      let season = currentSeason;
      if (season === null) {
        fallbackSeason += 1;
        season = fallbackSeason;
      } else {
        fallbackSeason = season;
      }

      let previous = null;
      // Walk rows in document order: each episode's plot lives in the
      // <tr class="expand-child"> that follows its <tr class="vevent"> row.
      for (const rowMatch of findAll(/<tr class="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g, table)) {
        const rowClass = rowMatch[1];
        const row = rowMatch[2];

        if (rowClass.includes('expand-child')) {
          const summary = wikiSummary(row);
          if (previous !== null && summary) {
            previous.synopsis = previous.synopsis ? `${previous.synopsis}\n\n${summary}` : summary;
          }
          continue;
        }
        if (!rowClass.includes('vevent')) continue;

        const cells = findAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g, row).map((m) => m[1]);
        if (!cells.length) continue;

        // Later duplicate header names overwrite earlier ones, as in Python.
        const byHeader = new Map();
        for (let i = 0; i < Math.min(headers.length, cells.length); i += 1) {
          byHeader.set(headers[i], cells[i]);
        }
        const pick = (...needles) => {
          for (const needle of needles) {
            for (const [name, cell] of byHeader) {
              if (name.includes(needle)) return cell;
            }
          }
          return '';
        };

        const summaryCell = row.match(
          /<t[hd][^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/t[hd]>/,
        );
        const titleCell = summaryCell ? summaryCell[1] : pick('title');
        const title = stripChars(
          stripTags(titleCell.split(/<br\s*\/?>/)[0]).trim(),
          '"“”',
        );
        const japanese = titleCell.match(/<span lang="ja">([\s\S]*?)<\/span>/);
        const romaji = titleCell.match(/lang="ja-Latn"[^>]*>([\s\S]*?)<\/span>/);

        const iso = row.match(/class="[^"]*dtstart[^"]*">\s*(\d{4}-\d{2}-\d{2})/);
        const aired = iso
          ? iso[1]
          : parseTextDate(pick('original air date', 'air date', 'released'));

        const inSeason = parseInt_(pick('no. in season', 'no. inseason', 'no.inseason'));
        const overall = parseInt_(cells[0]);
        const number = inSeason !== null ? inSeason : overall;
        const japaneseTitle = japanese ? stripTags(japanese[1]) : '';

        if (number === null) {
          // A row with no number cell is a continuation: the number and air
          // date above carry rowspan="2" because one episode holds two titled
          // segments. Fold the extra title into that episode instead of
          // dropping it or inventing a new episode.
          if (previous !== null && title) {
            previous.title = previous.title ? `${previous.title} / ${title}` : title;
            if (japaneseTitle) {
              previous.title_japanese = previous.title_japanese
                ? `${previous.title_japanese} / ${japaneseTitle}`
                : japaneseTitle;
            }
          }
          continue;
        }

        previous = newEpisode({
          season,
          number,
          // Keep the overall column even when the in-season one won above; it
          // is the source's own absolute numbering and cannot be recomputed
          // reliably (articles differ on whether recaps and specials count).
          number_absolute: inSeason !== null && overall !== null ? overall : null,
          title,
          title_japanese: japaneseTitle,
          title_romaji: romaji ? stripTags(romaji[1]) : '',
          aired,
          director: wikiPeople(pick('directed by', 'director')),
          writer: wikiPeople(pick('written by', 'writer', 'storyboarded by')),
        });
        episodes.push(previous);
      }
    }
  }
  return episodes;
}

export class WikipediaSource extends WebClient {
  static key = 'wikipedia';
  static label = 'Wikipedia';
  static hasSeasons = true;
  static refHint = 'Wikipedia article title or en.wikipedia.org URL';
  // Wikipedia throttles bursts from anonymous clients with 429s well before its
  // documented ceiling, and a whole series needs only two calls, so go slowly.
  static perSecond = 1.0;
  static perMinute = 20;

  get key() { return WikipediaSource.key; }
  get label() { return WikipediaSource.label; }
  get hasSeasons() { return WikipediaSource.hasSeasons; }

  static parseRef(text) {
    const value = (text || '').trim();
    const match = value.match(/en\.wikipedia\.org\/wiki\/([^?#]+)/i);
    if (match) return decodeURIComponent(match[1]).replace(/_/g, ' ');
    return value && !value.startsWith('http') ? value : '';
  }

  async api(params) {
    // origin=* is what makes the API answer a cross-origin browser request.
    // retries 6: a 429 here is a throttle that clears, not a dead end.
    const query = new URLSearchParams({
      format: 'json',
      formatversion: '2',
      origin: '*',
      ...params,
    });
    return this.getJson(`${WIKI_API}?${query}`, 6);
  }

  async search(term, limit = 20) {
    // Bias toward the article that actually holds an episode table.
    const query = /episode/i.test(term) ? term : `List of ${term} episodes`;
    const data = await this.api({
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: String(Math.max(limit, 10)),
      srnamespace: '0',
    });
    const results = ((data || {}).query || {}).search || [];
    const hits = [];
    for (const row of results.slice(0, limit)) {
      const title = row.title || '';
      if (!title) continue;
      hits.push(
        new SearchHit({
          ref: title,
          title,
          source: this.key,
          mediaType: 'ARTICLE',
          extra: /episode/i.test(title) ? 'episode list' : '',
        }),
      );
    }
    // Episode-list articles first: those are the ones that parse.
    hits.sort((a, b) => (a.extra ? 0 : 1) - (b.extra ? 0 : 1));
    return hits;
  }

  async pageHtml(ref) {
    const data = await this.api({ action: 'parse', page: ref, prop: 'text', redirects: '1' });
    if (data && data.error) {
      throw new ScrapeError(`Wikipedia: ${data.error.info || 'article not found'}`);
    }
    const text = ((data || {}).parse || {}).text || '';
    if (!text) throw new ScrapeError(`Wikipedia returned no content for '${ref}'.`);
    return text;
  }

  async show(ref) {
    const html = await this.pageHtml(ref);
    let title = ref.replace(/^List of\s+/i, '');
    title = title.replace(/\s+episodes$/i, '').trim();

    let lead = '';
    for (const para of findAll(/<p>([\s\S]*?)<\/p>/g, html)) {
      const text = stripTags(para[1], true);
      if (text.length > 120) {
        lead = text;
        break;
      }
    }

    const episodes = parseWikiEpisodeTables(html);
    const dates = episodes.map((e) => e.aired).filter(Boolean).sort();

    return new Show({
      ref,
      source: this.key,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(ref.replace(/ /g, '_'))}`,
      title,
      title_english: title,
      media_type: 'TV',
      episode_count: episodes.length || null,
      aired_from: dates.length ? dates[0] : '',
      aired_to: dates.length ? dates[dates.length - 1] : '',
      synopsis: lead,
      year: dates.length ? Number(dates[0].slice(0, 4)) : null,
    });
  }

  async episodes(ref, onPage = null) {
    const html = await this.pageHtml(ref);
    const episodes = parseWikiEpisodeTables(html);
    if (!episodes.length) throw new ScrapeError(this.explainEmpty(ref, html));
    if (onPage) onPage(1, 1, episodes.length);
    episodes.sort((a, b) => (a.season || 0) - (b.season || 0) || a.number - b.number);
    return episodes;
  }

  /** Linked 'List of ... episodes (season N)' style articles. */
  static subArticles(html) {
    const found = [];
    const seen = new Set();
    for (const match of findAll(/<a href="\/wiki\/([^"#]+)"[^>]*>([^<]*)<\/a>/g, html)) {
      const title = decodeURIComponent(match[1]).replace(/_/g, ' ');
      if (/^List of .* episodes\s*\(/i.test(title) && !seen.has(title)) {
        seen.add(title);
        found.push(title);
      }
    }
    return found;
  }

  /**
   * Say *why* nothing was found, because 'no episodes' on Wikipedia almost
   * always means the wrong article rather than missing data.
   */
  explainEmpty(ref, html) {
    if (!html.includes('module-episode-list-row')) {
      const subs = WikipediaSource.subArticles(html);
      if (subs.length) {
        const listing = subs.slice(0, 12).map((s) => `    ${s}`).join('\n');
        return (
          `'${ref}' has no episode tables of its own - this show splits its ` +
          `episodes across sub-articles. Use one of these instead:\n${listing}`
        );
      }
      return (
        `'${ref}' contains no episode tables. Wikipedia keeps them in a ` +
        "'List of <show> episodes' article - try searching for that rather " +
        "than the show's main article."
      );
    }
    return (
      `'${ref}' has episode tables, but none under a heading this tool reads as ` +
      'episode content. Sections for spin-offs, home media and references are ' +
      'skipped deliberately so their rows are not mixed into the seasons.'
    );
  }

  /** Nothing extra to fetch: the article table already carries everything. */
  async fetchDetail() {}

  /** Episode-list articles carry no usable cast data. */
  async cast() {
    return [];
  }
}
