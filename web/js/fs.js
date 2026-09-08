/**
 * Output folder access.
 *
 * The desktop tool writes straight into a path you type. A web page cannot do
 * that, but the File System Access API gets close: the browser hands back a
 * handle to a folder the user picked, and everything below writes through it.
 * The handle survives in IndexedDB between visits, so the folder only has to be
 * chosen once — re-granting permission is a single click on the next visit.
 *
 * Chromium only (Chrome, Edge, Opera, Brave). Firefox and Safari have not
 * shipped showDirectoryPicker.
 */

const DB_NAME = 'nfo-exporter';
const STORE = 'handles';
const HANDLE_KEY = 'outputRoot';

export function isSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Prompt for the output root and remember it. */
export async function pickOutputRoot() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'nfo-output' });
  try {
    await idbSet(HANDLE_KEY, handle);
  } catch {
    /* handle persistence is a convenience, not a requirement */
  }
  return handle;
}

/** The folder from a previous visit, if permission is still granted. */
export async function restoreOutputRoot({ prompt = false } = {}) {
  let handle;
  try {
    handle = await idbGet(HANDLE_KEY);
  } catch {
    return null;
  }
  if (!handle || typeof handle.queryPermission !== 'function') return null;
  const options = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(options)) === 'granted') return handle;
    if (prompt && (await handle.requestPermission(options)) === 'granted') return handle;
  } catch {
    // A handle whose folder was moved or deleted throws here.
    return null;
  }
  return null;
}

export async function ensurePermission(handle) {
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  return (await handle.requestPermission(options)) === 'granted';
}

export async function getSubdirectory(parent, name) {
  return parent.getDirectoryHandle(name, { create: true });
}

export async function fileExists(directory, name) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (err) {
    if (err && err.name === 'NotFoundError') return false;
    throw err;
  }
}

export async function writeTextFile(directory, name, text) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([text], { type: 'text/xml;charset=utf-8' }));
  } finally {
    await writable.close();
  }
}

export async function writeBinaryFile(directory, name, bytes) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}
