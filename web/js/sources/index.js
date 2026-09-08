import { ScrapeError } from '../util.js';
import { MalSource } from './mal.js';
import { TvdbSource } from './tvdb.js';
import { WikipediaSource } from './wikipedia.js';

export { MalSource, TvdbSource, WikipediaSource };

export const SOURCE_CLASSES = {
  mal: MalSource,
  tvdb: TvdbSource,
  wikipedia: WikipediaSource,
};

export function getSource(key, { signal = null, log = () => {} } = {}) {
  const cls = SOURCE_CLASSES[key];
  if (!cls) {
    throw new ScrapeError(
      `Unknown source '${key}'. Choose from: ${Object.keys(SOURCE_CLASSES).join(', ')}`,
    );
  }
  return new cls({ signal, log });
}
