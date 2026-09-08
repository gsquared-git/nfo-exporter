// Minimal browser stubs so the modules can be imported under Node.
// The entity table is Python's html.entities.html5, which is the HTML5 named
// character reference list a real browser also uses.
import fs from 'node:fs';
const ENTITIES = JSON.parse(fs.readFileSync(new URL('./entities.json', import.meta.url), 'utf8'));
const NAMES = Object.keys(ENTITIES).sort((a, b) => b.length - a.length);

function decode(input) {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const amp = input.indexOf('&', i);
    if (amp === -1) { out += input.slice(i); break; }
    out += input.slice(i, amp);
    const rest = input.slice(amp);
    const num = rest.match(/^&#(?:[xX]([0-9a-fA-F]+)|(\d+));?/);
    if (num) {
      const code = num[1] ? parseInt(num[1], 16) : parseInt(num[2], 10);
      out += String.fromCodePoint(code);
      i = amp + num[0].length;
      continue;
    }
    const name = NAMES.find((n) => rest.startsWith('&' + n));
    if (name) { out += ENTITIES[name]; i = amp + 1 + name.length; continue; }
    out += '&';
    i = amp + 1;
  }
  return out;
}

globalThis.document = {
  createElement() {
    return { set innerHTML(v) { this._v = decode(v); }, get value() { return this._v; } };
  },
};
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };
