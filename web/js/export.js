/** run_export, ported. Pulls one series from the chosen source and writes the NFO tree. */

import { getSource } from './sources/index.js';
import { Cancelled, ScrapeError, cleanText, pad2 } from './util.js';
import {
  buildEpisodeXml, buildSeasonXml, buildTvshowXml, posterCandidates,
  renderXml, safeFilename, seasonFolderName,
} from './nfo.js';

export const DEFAULT_OPTIONS = {
  ref: '',
  source: 'mal',
  season: 1,
  allSeasons: false,
  showName: '',
  episodeOffset: 0,
  preferEnglish: true,
  fetchSynopsis: false,
  writeTvshow: true,
  writeSeasonNfo: true,
  includeCast: true,
  castLanguage: 'Japanese',
  downloadPoster: false,
  overwrite: true,
  yearInFolder: true,
  outputMode: 'zip',
  tvdbId: '',
  tmdbId: '',
  imdbId: '',
  anidbId: '',
  extraGenres: [],
};

export async function runExport(options, {
  sink,
  log = () => {},
  progress = () => {},
  signal = null,
} = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const source = getSource(opts.source, { signal, log });

  const checkCancelled = () => {
    if (signal && signal.aborted) throw new Cancelled();
  };

  const result = {
    folderName: '',
    seasonFolders: [],
    perSeason: {},
    episodesWritten: 0,
    episodesSkipped: 0,
    synopsesFound: 0,
    synopsesMissing: 0,
    warnings: [],
    archive: null,
  };

  log(`Fetching '${opts.ref}' from ${source.label} ...`);
  progress(0, 1, 'Fetching show details');
  const show = await source.show(opts.ref);

  const showTitle = opts.showName || show.displayTitle(opts.preferEnglish);
  const year = show.displayYear;
  log(
    `  ${showTitle}${year ? ` (${year})` : ''} - ${show.media_type || '?'}` +
      (show.episode_count ? `, ${show.episode_count} episodes listed` : ''),
  );

  // An explicit show name defines the folder verbatim. Appending the year here
  // would send each sequel to its own folder (a 2026 season 2 next to a 2023
  // season 1), which breaks the one-entry-per-season workflow.
  const folderName = opts.showName
    ? safeFilename(opts.showName)
    : safeFilename(opts.yearInFolder && year ? `${showTitle} (${year})` : showTitle);
  result.folderName = folderName;

  let cast = [];
  if (opts.includeCast) {
    log('Fetching cast ...');
    progress(0, 1, 'Fetching cast');
    cast = await source.cast(opts.ref, opts.castLanguage);
    log(`  ${cast.length} actors${source.key === 'mal' ? ` (${opts.castLanguage})` : ''}`);
    if (!cast.length) {
      result.warnings.push(`${source.label} returned no cast for this entry.`);
    }
  }

  log('Fetching episode list ...');
  const onPage = (page, last, runningTotal) => {
    if (last > 1) log(`  page ${page}/${last} - ${runningTotal} episodes so far`);
    progress(page, last, 'Fetching episode list');
  };

  const episodes = await source.episodes(opts.ref, onPage);
  if (!episodes.length) {
    throw new ScrapeError(
      `${source.label} lists no episodes for this entry. Movies and single-episode ` +
        'OVAs have no episode list; on Wikipedia, make sure the article is the ' +
        "'List of ... episodes' one.",
    );
  }
  log(`  ${episodes.length} episodes retrieved`);

  // Group into seasons. Sources without season numbering get the chosen season.
  let grouped = new Map();
  for (const episode of episodes) {
    const season = episode.season === null || episode.season === undefined
      ? opts.season
      : Number(episode.season);
    if (!grouped.has(season)) grouped.set(season, []);
    grouped.get(season).push(episode);
  }

  if (grouped.size > 1 && !opts.allSeasons) {
    const wanted = grouped.get(opts.season) || [];
    let dropped = 0;
    for (const [key, value] of grouped) if (key !== opts.season) dropped += value.length;
    grouped = new Map([[opts.season, wanted]]);
    log(
      `  restricted to season ${opts.season} (${dropped} episodes in other seasons ` +
        'skipped - use all-seasons to include them)',
    );
    if (!wanted.length) {
      throw new ScrapeError(
        `${source.label} has no season ${opts.season} for this series. ` +
          'Enable all-seasons, or pick a season that exists.',
      );
    }
  }

  const seasonKeys = [...grouped.keys()].sort((a, b) => a - b);
  if (grouped.size > 1) {
    log(
      '  seasons found: ' +
        seasonKeys.map((s) => `${s === 0 ? 'Specials' : s}=${grouped.get(s).length}`).join(', '),
    );
  }

  // Per-episode detail is one page fetch each, so only do it for the episodes
  // that survived the season filter — not for every season being discarded.
  if (opts.fetchSynopsis) {
    const keep = seasonKeys.flatMap((season) => grouped.get(season));
    log(
      `  fetching per-episode detail for ${keep.length} episodes ` +
        '(one page each, so this is slow) ...',
    );
    for (let index = 0; index < keep.length; index += 1) {
      checkCancelled();
      await source.fetchDetail(opts.ref, keep[index]);
      progress(index + 1, keep.length, `Episode detail ${index + 1}/${keep.length}`);
      if ((index + 1) % 25 === 0 || index + 1 === keep.length) {
        log(`    ${index + 1}/${keep.length}`);
      }
    }
  }

  if (opts.writeTvshow) {
    const path = `${folderName}/tvshow.nfo`;
    if (!opts.overwrite && (await sink.exists(path))) {
      log('Skipped tvshow.nfo (already exists)');
    } else {
      await sink.writeText(path, renderXml(buildTvshowXml(show, opts, cast)));
      log('Wrote tvshow.nfo');
    }
  }

  if (opts.downloadPoster) {
    const candidates = posterCandidates(show.poster);
    if (candidates.length) {
      let existing = null;
      for (const ext of ['.jpg', '.webp', '.png']) {
        if (await sink.exists(`${folderName}/folder${ext}`)) {
          existing = `folder${ext}`;
          break;
        }
      }
      if (existing && !opts.overwrite) {
        log(`Skipped ${existing} (already exists)`);
      } else {
        let lastError = null;
        for (const url of candidates) {
          const suffix = (new URL(url).pathname.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0];
          try {
            const bytes = await source.downloadBytes(url);
            await sink.writeBytes(`${folderName}/folder${suffix}`, bytes);
            log(`Downloaded folder${suffix}`);
            lastError = null;
            break;
          } catch (err) {
            if (err instanceof Cancelled) throw err;
            lastError = err;
          }
        }
        if (lastError !== null) {
          result.warnings.push(`Poster download failed: ${lastError.message || lastError}`);
          log(`  poster download failed: ${lastError.message || lastError}`);
        }
      }
    } else {
      result.warnings.push(`${source.label} has no poster image for this entry.`);
    }
  }

  const total = seasonKeys.reduce((sum, s) => sum + grouped.get(s).length, 0);
  let done = 0;

  for (const season of seasonKeys) {
    const seasonEpisodes = grouped.get(season);
    const folder = seasonFolderName(season);
    result.seasonFolders.push(folder);

    if (opts.writeSeasonNfo) {
      const path = `${folderName}/${folder}/season.nfo`;
      if (!opts.overwrite && (await sink.exists(path))) {
        log(`Skipped ${folder}/season.nfo (already exists)`);
      } else {
        await sink.writeText(path, renderXml(buildSeasonXml(show, season)));
        log(`Wrote ${folder}/season.nfo`);
      }
    }

    log(`Writing ${seasonEpisodes.length} episode NFO files to ${folderName}/${folder} ...`);
    let written = 0;

    for (let index = 0; index < seasonEpisodes.length; index += 1) {
      checkCancelled();
      const episode = seasonEpisodes[index];
      done += 1;

      const rawNumber = episode.number;
      const baseNumber = Number.isInteger(rawNumber) ? rawNumber : index + 1;
      let episodeNumber = baseNumber + opts.episodeOffset;
      if (episodeNumber < 0) episodeNumber = index + 1 + opts.episodeOffset;

      const name = `${safeFilename(showTitle)} S${pad2(season)}E${pad2(episodeNumber)}.nfo`;
      const path = `${folderName}/${folder}/${name}`;

      if (!opts.overwrite && (await sink.exists(path))) {
        result.episodesSkipped += 1;
        progress(done, total, `Skipped S${pad2(season)}E${pad2(episodeNumber)}`);
        continue;
      }

      if (opts.fetchSynopsis) {
        if (cleanText(episode.synopsis)) result.synopsesFound += 1;
        else result.synopsesMissing += 1;
      }

      await sink.writeText(
        path,
        renderXml(
          buildEpisodeXml(episode, show, showTitle, season, episodeNumber, source.hasSeasons),
        ),
      );
      result.episodesWritten += 1;
      written += 1;
      progress(
        done,
        total,
        `S${pad2(season)}E${pad2(episodeNumber)} - ${cleanText(episode.title).slice(0, 38)}`,
      );
    }
    result.perSeason[season] = written;
  }

  if (opts.fetchSynopsis && result.synopsesMissing) {
    result.warnings.push(
      `${result.synopsesMissing} of ${total} episodes had no plot on ${source.label}.`,
    );
  }
  if (source.key === 'wikipedia' && opts.writeTvshow) {
    result.warnings.push(
      'Wikipedia has little series-level data, so tvshow.nfo is sparse. For richer ' +
        'series details, run MyAnimeList first, then Wikipedia with tvshow.nfo disabled.',
    );
  }

  result.archive = await sink.finish(`${folderName}.zip`);

  log('');
  log(
    `Done. ${result.episodesWritten} episode NFOs written across ` +
      `${Object.keys(result.perSeason).length} season(s)` +
      (result.episodesSkipped ? `, ${result.episodesSkipped} skipped` : '') +
      '.',
  );
  if (result.archive) {
    const kb = Math.max(1, Math.round(result.archive.bytes / 1024));
    log(`Downloaded ${folderName}.zip - ${result.archive.files} files, ${kb} KB.`);
    log('Extract it into your Emby library root, keeping the folder structure.');
  }
  for (const warning of result.warnings) log(`Warning: ${warning}`);
  return result;
}
