/**
 * Where the exported files go.
 *
 * Two implementations behind one path-based interface, so the export itself
 * never has to know which is in use:
 *
 *   ZipSink     collects everything and hands over one .zip download.
 *               Works in every browser.
 *   FolderSink  writes straight into a folder you picked, via the File System
 *               Access API. Chromium only, and nicer for repeat runs because
 *               there is nothing to unzip.
 *
 * Paths are always forward-slashed and relative to the output root, e.g.
 * "Attack on Titan (2013)/Season 01/Attack on Titan S01E01.nfo".
 */

import { ZipBuilder, downloadBlob } from './zip.js';
import { fileExists, getSubdirectory, writeBinaryFile, writeTextFile } from './fs.js';

export function folderModeSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function splitPath(path) {
  const parts = path.split('/').filter(Boolean);
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] };
}

export class ZipSink {
  constructor() {
    this.zip = new ZipBuilder();
  }

  get label() {
    return 'ZIP download';
  }

  /** Nothing pre-exists inside a brand-new archive. */
  async exists() {
    return false;
  }

  async writeText(path, text) {
    await this.zip.addText(path, text);
  }

  async writeBytes(path, bytes) {
    await this.zip.addBytes(path, bytes);
  }

  async finish(archiveName) {
    if (!this.zip.fileCount) return null;
    const blob = this.zip.build();
    downloadBlob(blob, archiveName);
    return { files: this.zip.fileCount, bytes: blob.size };
  }
}

export class FolderSink {
  constructor(root) {
    this.root = root;
    this.cache = new Map([['', root]]);
  }

  get label() {
    return this.root.name;
  }

  /** Resolve (and create) the directory chain for a file path. */
  async directoryFor(dirs) {
    let key = '';
    let handle = this.root;
    for (const segment of dirs) {
      key = key ? `${key}/${segment}` : segment;
      if (this.cache.has(key)) {
        handle = this.cache.get(key);
      } else {
        handle = await getSubdirectory(handle, segment);
        this.cache.set(key, handle);
      }
    }
    return handle;
  }

  async exists(path) {
    const { dirs, name } = splitPath(path);
    const directory = await this.directoryFor(dirs);
    return fileExists(directory, name);
  }

  async writeText(path, text) {
    const { dirs, name } = splitPath(path);
    const directory = await this.directoryFor(dirs);
    await writeTextFile(directory, name, text);
  }

  async writeBytes(path, bytes) {
    const { dirs, name } = splitPath(path);
    const directory = await this.directoryFor(dirs);
    await writeBinaryFile(directory, name, bytes);
  }

  async finish() {
    return null;
  }
}
