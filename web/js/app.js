/** Wiring: the tkinter GUI's job, done with DOM events. */

import { getProxyUrl, setProxyUrl, testProxy } from './http.js';
import { SOURCE_CLASSES, getSource } from './sources/index.js';
import { CAST_LANGUAGES } from './nfo.js';
import { DEFAULT_OPTIONS, runExport } from './export.js';
import { Cancelled } from './util.js';
import {
  ensurePermission, isSupported, pickOutputRoot, restoreOutputRoot,
} from './fs.js';

const CONFIG_KEY = 'nfoExporter.config';

const $ = (id) => document.getElementById(id);

const els = {
  unsupported: $('unsupported'),
  settingsToggle: $('settings-toggle'),
  settings: $('settings'),
  proxyUrl: $('proxy-url'),
  proxyTest: $('proxy-test'),
  proxyStatus: $('proxy-status'),
  searchForm: $('search-form'),
  searchTerm: $('search-term'),
  searchButton: $('search-button'),
  searchStatus: $('search-status'),
  results: $('results'),
  refLabel: $('ref-label'),
  ref: $('ref'),
  pickFolder: $('pick-folder'),
  folderName: $('folder-name'),
  showName: $('show-name'),
  season: $('season'),
  episodeOffset: $('episode-offset'),
  castLanguage: $('cast-language'),
  tvdbId: $('tvdb-id'),
  tmdbId: $('tmdb-id'),
  anidbId: $('anidb-id'),
  exportButton: $('export'),
  cancelButton: $('cancel'),
  progressLabel: $('progress-label'),
  progressBar: $('progress-bar'),
  log: $('log'),
};

const CHECKBOXES = {
  allSeasons: $('all-seasons'),
  preferEnglish: $('prefer-english'),
  fetchSynopsis: $('fetch-synopsis'),
  writeTvshow: $('write-tvshow'),
  writeSeasonNfo: $('write-season-nfo'),
  includeCast: $('include-cast'),
  downloadPoster: $('download-poster'),
  overwrite: $('overwrite'),
  yearInFolder: $('year-in-folder'),
};

let outputRoot = null;
let controller = null;

// --------------------------------------------------------------------------- //
// Log and progress
// --------------------------------------------------------------------------- //

function log(message) {
  els.log.textContent += `${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function clearLog() {
  els.log.textContent = '';
}

function setProgress(done, total, label) {
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  els.progressBar.style.width = `${percent}%`;
  els.progressLabel.textContent = label || '';
}

function setStatus(node, message, kind = '') {
  node.textContent = message;
  node.className = `status${kind ? ` ${kind}` : ''}`;
}

// --------------------------------------------------------------------------- //
// Config
// --------------------------------------------------------------------------- //

function currentSource() {
  return document.querySelector('input[name="source"]:checked').value;
}

function readForm() {
  return {
    ref: els.ref.value.trim(),
    source: currentSource(),
    season: Number(els.season.value) || 0,
    showName: els.showName.value.trim(),
    episodeOffset: Number(els.episodeOffset.value) || 0,
    castLanguage: els.castLanguage.value,
    tvdbId: els.tvdbId.value.trim(),
    tmdbId: els.tmdbId.value.trim(),
    anidbId: els.anidbId.value.trim(),
    ...Object.fromEntries(
      Object.entries(CHECKBOXES).map(([key, node]) => [key, node.checked]),
    ),
  };
}

function saveConfig() {
  const values = readForm();
  delete values.ref;
  delete values.showName;
  delete values.tvdbId;
  delete values.tmdbId;
  delete values.anidbId;
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(values));
  } catch {
    /* private mode */
  }
}

function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
  } catch {
    stored = {};
  }
  const values = { ...DEFAULT_OPTIONS, ...stored };

  const radio = document.querySelector(`input[name="source"][value="${values.source}"]`);
  if (radio) radio.checked = true;

  els.season.value = values.season;
  els.episodeOffset.value = values.episodeOffset;
  for (const [key, node] of Object.entries(CHECKBOXES)) {
    if (typeof values[key] === 'boolean') node.checked = values[key];
  }

  els.castLanguage.innerHTML = '';
  for (const language of CAST_LANGUAGES) {
    const option = document.createElement('option');
    option.value = language;
    option.textContent = language;
    if (language === values.castLanguage) option.selected = true;
    els.castLanguage.append(option);
  }

  els.proxyUrl.value = getProxyUrl();
  updateRefHint();
}

function updateRefHint() {
  const cls = SOURCE_CLASSES[currentSource()];
  els.refLabel.textContent = cls.refHint;
  els.ref.placeholder =
    currentSource() === 'mal'
      ? 'e.g. 16498'
      : currentSource() === 'tvdb'
        ? 'e.g. attack-on-titan'
        : 'e.g. List of Attack on Titan episodes';
}

// --------------------------------------------------------------------------- //
// Search
// --------------------------------------------------------------------------- //

async function doSearch(event) {
  event.preventDefault();
  const term = els.searchTerm.value.trim();
  if (!term) return;

  els.searchButton.disabled = true;
  els.results.hidden = true;
  els.results.innerHTML = '';
  setStatus(els.searchStatus, 'Searching…');

  try {
    const source = getSource(currentSource(), { log });
    const hits = await source.search(term);
    if (!hits.length) {
      setStatus(els.searchStatus, 'No results.');
      return;
    }
    for (const hit of hits) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const title = document.createElement('div');
      title.textContent = hit.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const bits = [
        hit.mediaType,
        hit.year,
        hit.episodeCount ? `${hit.episodeCount} eps` : '',
        hit.extra,
        hit.ref,
      ].filter(Boolean);
      meta.textContent = bits.join(' · ');
      button.append(title, meta);
      button.addEventListener('click', () => {
        els.ref.value = hit.ref;
        if (!els.showName.value) els.searchTerm.value = hit.title;
        setStatus(els.searchStatus, `Selected: ${hit.title}`, 'ok');
      });
      item.append(button);
      els.results.append(item);
    }
    els.results.hidden = false;
    setStatus(els.searchStatus, `${hits.length} results — pick one to fill in the reference.`);
  } catch (err) {
    setStatus(els.searchStatus, err.message || String(err), 'err');
  } finally {
    els.searchButton.disabled = false;
  }
}

// --------------------------------------------------------------------------- //
// Folder
// --------------------------------------------------------------------------- //

async function chooseFolder() {
  try {
    // A click is a real user gesture, which is what requestPermission needs, so
    // try to re-grant last session's folder before opening the picker.
    const restored = await restoreOutputRoot({ prompt: true });
    if (restored) {
      outputRoot = restored;
      setStatus(els.folderName, `${restored.name} (remembered)`, 'ok');
      return;
    }
    outputRoot = await pickOutputRoot();
    setStatus(els.folderName, outputRoot.name, 'ok');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    setStatus(els.folderName, err.message || String(err), 'err');
  }
}

// --------------------------------------------------------------------------- //
// Export
// --------------------------------------------------------------------------- //

async function doExport() {
  const options = readForm();
  const cls = SOURCE_CLASSES[options.source];
  const ref = cls.parseRef(options.ref) || options.ref;

  if (!ref) {
    log(`Could not read a ${cls.refHint} from "${options.ref}".`);
    return;
  }
  if (!outputRoot) {
    log('Choose an output folder first.');
    return;
  }
  if (!(await ensurePermission(outputRoot))) {
    log('Write permission for that folder was declined.');
    return;
  }

  saveConfig();
  clearLog();
  controller = new AbortController();
  els.exportButton.disabled = true;
  els.cancelButton.disabled = false;

  try {
    const result = await runExport(
      { ...options, ref },
      { outputRoot, log, progress: setProgress, signal: controller.signal },
    );
    setProgress(1, 1, `${result.episodesWritten} files written`);
  } catch (err) {
    if (err instanceof Cancelled || err.name === 'AbortError') {
      log('');
      log('Cancelled.');
      setProgress(0, 1, 'Cancelled');
    } else {
      log('');
      log(`Export failed: ${err.message || err}`);
      setProgress(0, 1, 'Failed');
    }
  } finally {
    controller = null;
    els.exportButton.disabled = false;
    els.cancelButton.disabled = true;
  }
}

// --------------------------------------------------------------------------- //
// Boot
// --------------------------------------------------------------------------- //

function bind() {
  els.settingsToggle.addEventListener('click', () => {
    const open = els.settings.hidden;
    els.settings.hidden = !open;
    els.settingsToggle.setAttribute('aria-expanded', String(open));
  });

  els.proxyUrl.addEventListener('change', () => {
    setProxyUrl(els.proxyUrl.value.trim());
    setStatus(els.proxyStatus, 'Saved.', 'ok');
  });

  els.proxyTest.addEventListener('click', async () => {
    const url = els.proxyUrl.value.trim();
    if (!url) {
      setStatus(els.proxyStatus, 'Enter a proxy URL first.', 'err');
      return;
    }
    setProxyUrl(url);
    els.proxyTest.disabled = true;
    setStatus(els.proxyStatus, 'Testing…');
    try {
      await testProxy(url);
      setStatus(els.proxyStatus, 'Proxy is reachable and MyAnimeList responded.', 'ok');
    } catch (err) {
      setStatus(els.proxyStatus, err.message || String(err), 'err');
    } finally {
      els.proxyTest.disabled = false;
    }
  });

  for (const radio of document.querySelectorAll('input[name="source"]')) {
    radio.addEventListener('change', () => {
      updateRefHint();
      saveConfig();
    });
  }

  els.searchForm.addEventListener('submit', doSearch);
  els.pickFolder.addEventListener('click', chooseFolder);
  els.exportButton.addEventListener('click', doExport);
  els.cancelButton.addEventListener('click', () => {
    if (controller) controller.abort();
  });

  for (const node of Object.values(CHECKBOXES)) {
    node.addEventListener('change', saveConfig);
  }
  for (const node of [els.season, els.episodeOffset, els.castLanguage]) {
    node.addEventListener('change', saveConfig);
  }
}

async function boot() {
  if (!isSupported()) {
    els.unsupported.hidden = false;
    els.pickFolder.disabled = true;
    els.exportButton.disabled = true;
  }

  loadConfig();
  bind();

  if (isSupported()) {
    // Silent restore only. If permission has lapsed, "Choose folder" re-grants
    // it on click — requestPermission is refused without a user gesture.
    const restored = await restoreOutputRoot();
    if (restored) {
      outputRoot = restored;
      setStatus(els.folderName, `${restored.name} (remembered)`, 'ok');
    } else {
      setStatus(els.folderName, 'No folder chosen');
    }
  }

  log('Ready.');
  if (!getProxyUrl()) {
    log('No proxy configured — MyAnimeList and TheTVDB will fail. Wikipedia works as is.');
    log('Set one under Settings; see the README for the one-command Cloudflare deploy.');
  }
}

boot();
