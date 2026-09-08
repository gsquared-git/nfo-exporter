/**
 * Per-season vs absolute numbering, end to end through ZipSink.
 *
 * Python has no absolute mode, so there is nothing to diff against; these are
 * direct assertions on the paths and on the XML tags that decide how Emby files
 * and displays each episode.
 *
 *   node numbering.mjs
 */

import './domstub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Capture what downloadBlob would hand the browser.
let captured = null;
globalThis.URL.createObjectURL = (blob) => { captured = blob; return 'blob:test'; };
globalThis.URL.revokeObjectURL = () => {};
const realCreate = globalThis.document.createElement.bind(globalThis.document);
globalThis.document.createElement = (tag) => (tag === 'a'
  ? { set href(v) {}, set download(v) {}, set rel(v) {}, click() {}, remove() {} }
  : realCreate(tag));
globalThis.document.body = { append() {} };

const WEB = new URL('../js/', import.meta.url).href;
const F = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fix = (name) => fs.readFileSync(path.join(F, name), 'utf8');

const { runExport } = await import(`${WEB}export.js`);
const { ZipSink } = await import(`${WEB}sink.js`);
const sources = await import(`${WEB}sources/index.js`);

const TVDB_ROUTES = {
  '/allseasons/official': 'tvdb_seasons.html',
  '/episodes/': 'tvdb_episode.html',
  '/series/': 'tvdb_show.html',
};
sources.SOURCE_CLASSES.tvdb.prototype.get = async function serve(url) {
  for (const [needle, name] of Object.entries(TVDB_ROUTES)) {
    if (url.includes(needle)) return fix(name);
  }
  throw new Error(`no fixture: ${url}`);
};
sources.SOURCE_CLASSES.wikipedia.prototype.pageHtml = async () => fix('wiki_page.html');

/** Run an export and return { paths, files } read back out of the archive. */
async function exportRun(options) {
  captured = null;
  const sink = new ZipSink();
  const result = await runExport({ includeCast: false, allSeasons: true, ...options },
    { sink, log: () => {} });
  const bytes = new Uint8Array(await captured.arrayBuffer());
  return { result, bytes };
}

/** Pull filenames and a few tags out of a zip without a zip library:
 *  read the local file headers, which carry names in order. */
function entryNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
}

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}\n        want ${e}\n        got  ${a}`);
  }
}

// --------------------------------------------------------------------------- //
// TVDB: two real seasons plus a special. No series-wide numbers published, so
// the absolute run has to be counted in air order.
// --------------------------------------------------------------------------- //

const tvdbSeason = await exportRun({ ref: 'attack-on-titan', source: 'tvdb', numbering: 'season' });
check('tvdb / per season', entryNames(tvdbSeason.bytes), [
  'Attack on Titan (2013)/tvshow.nfo',
  'Attack on Titan (2013)/Season 00/season.nfo',
  'Attack on Titan (2013)/Season 00/Attack on Titan S00E14.nfo',
  'Attack on Titan (2013)/Season 01/season.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E01.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E02.nfo',
]);

const tvdbAbsolute = await exportRun({ ref: 'attack-on-titan', source: 'tvdb', numbering: 'absolute' });
check('tvdb / absolute — specials stay in Season 00', entryNames(tvdbAbsolute.bytes), [
  'Attack on Titan (2013)/tvshow.nfo',
  'Attack on Titan (2013)/Season 00/season.nfo',
  'Attack on Titan (2013)/Season 00/Attack on Titan S00E14.nfo',
  'Attack on Titan (2013)/Season 01/season.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E01.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E02.nfo',
]);

// --------------------------------------------------------------------------- //
// Wikipedia: season 1 has episodes 1-2 (overall 1-2), season 2 has episode 1
// (overall 26). Absolute mode must honour that 26 rather than counting to 3.
// --------------------------------------------------------------------------- //

const WIKI_REF = 'List of Attack on Titan episodes';

const wikiSeason = await exportRun({ ref: WIKI_REF, source: 'wikipedia', numbering: 'season' });
check('wikipedia / per season', entryNames(wikiSeason.bytes), [
  'Attack on Titan (2013)/tvshow.nfo',
  'Attack on Titan (2013)/Season 01/season.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E01.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E02.nfo',
  'Attack on Titan (2013)/Season 02/season.nfo',
  'Attack on Titan (2013)/Season 02/Attack on Titan S02E01.nfo',
]);

const wikiAbsolute = await exportRun({ ref: WIKI_REF, source: 'wikipedia', numbering: 'absolute' });
check('wikipedia / absolute — one folder, No. overall honoured', entryNames(wikiAbsolute.bytes), [
  'Attack on Titan (2013)/tvshow.nfo',
  'Attack on Titan (2013)/Season 01/season.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E01.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E02.nfo',
  'Attack on Titan (2013)/Season 01/Attack on Titan S01E26.nfo',
]);

// --------------------------------------------------------------------------- //
// The XML behind that last file: filed as S01E26, displayed as season 2
// episode 1, and its uniqueid still keyed on the real season.
// --------------------------------------------------------------------------- //

const { buildEpisodeXml, renderXml } = await import(`${WEB}nfo.js`);
const { WikipediaSource } = await import(`${WEB}sources/wikipedia.js`);

const wiki = new WikipediaSource({});
const show = await wiki.show(WIKI_REF);
const episodes = await wiki.episodes(WIKI_REF);
const seasonTwoOpener = episodes.find((e) => e.season === 2 && e.number === 1);

check('wikipedia keeps No. overall', seasonTwoOpener.number_absolute, 26);

const xml = renderXml(buildEpisodeXml(
  seasonTwoOpener, show, 'Attack on Titan', 1, 26, true,
  { season: 2, episode: 1 }, 2,
));
const tag = (name) => (xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [null, null])[1];

check('filed season', tag('season'), '1');
check('filed episode', tag('episode'), '26');
check('displayed season', tag('displayseason'), '2');
check('displayed episode', tag('displayepisode'), '1');
check('uniqueid keyed on real season', /<uniqueid type="wikipediaepisode">([^<]*)</.exec(xml)[1],
  'List of Attack on Titan episodes-2x1');

// Offset applies to the filed number only, never to the displayed one.
const offsetXml = renderXml(buildEpisodeXml(
  seasonTwoOpener, show, 'Attack on Titan', 1, 26 + 100, true,
  { season: 2, episode: 1 }, 2,
));
check('offset moves filed episode', /<episode>([^<]*)</.exec(offsetXml)[1], '126');
check('offset leaves displayed episode',
  /<displayepisode>([^<]*)</.exec(offsetXml)[1], '1');

console.log();
console.log(failures ? `FAILED (${failures})` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
