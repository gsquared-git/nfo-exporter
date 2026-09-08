# Port equivalence tests

Proves the JavaScript in `web/js/` produces the same output as `nfo_exporter.py`
and `sources.py` for the same input. No network: everything runs against the
saved markup in `fixtures/`.

```bash
cd web/test
python ref.py      # Python tool  -> py.json (+ entities.json for the Node stub)
node port.mjs      # JS port      -> js.json
python diff.py     # compares, exits non-zero on any mismatch

node numbering.mjs # per-season vs absolute numbering (web-only, no Python side)
```

Requires Python 3.9+ and Node 18+. Nothing to install.

## What it compares

| Section | Covers |
| --- | --- |
| `mal_show`, `tvdb_show`, `wiki_show` | every field of the `Show` model, end to end through `show()` |
| `mal_episodes`, `tvdb_episodes`, `wiki_episodes` | episode records: numbering, seasons, titles, ISO dates, plots |
| `mal_cast_ja`, `mal_cast_en`, `tvdb_cast` | cast extraction, dub-language fallback, sort order, the 30-actor cap |
| `tvdb_detail` | `fetch_detail` promoting the English title and keeping the original as `originaltitle` |
| `helpers` | 14 helpers across their edge cases — date parsing, durations, rating tokens, Windows filename sanitising |
| `xml_*` | six complete NFO documents, compared as text |

The XML comparison is the important one: it is a character-for-character diff of
the finished files, so indentation, attribute order, entity escaping and the
`uniqueid` / `default="true"` logic all have to match.

`diff.py` ignores fields the JS side adds and Python has no equivalent for — the
`Show` getters, and `number_absolute` on episodes — but never ignores a
*difference* in anything Python does publish.

`numbering.mjs` is separate because the desktop tool has no absolute mode, so
there is nothing to diff against. It runs full exports through `ZipSink` and
asserts the resulting archive paths, then checks the XML directly: that an
episode filed as `S01E26` carries `<displayseason>2</displayseason>`, that its
`uniqueid` stays keyed on the real season so re-exporting under a different mode
does not change its identity, and that an episode offset moves the filed number
without moving the displayed one.

## Fixtures

`fixtures/` is hand-written markup shaped like the real pages, deliberately
including the awkward cases the parsers exist to handle:

- MAL's `episode-poll` vs `episode-forum` `data-raw` collision
- MAL's `Romaji (Japanese)` secondary title cell, and the per-language VA table
- TVDB's hidden `change_translation_text` blocks, and `SPECIAL 0x14` labels
  alongside `S01E01` ones
- an unlabelled TVDB list item, which must be skipped rather than numbered
- Wikipedia's `expand-child` summary rows, `[2]` citation markers, a `rowspan`
  continuation row that folds two segments into one episode, and a `Home media`
  section that must not be read as episodes

Adding a fixture means adding it to both `ref.py` and `port.mjs`.

## The Node DOM stub

`domstub.mjs` supplies the three browser globals the modules touch under Node:
`document.createElement('textarea')` for entity decoding, `localStorage`, and
`performance`. The entity decoder is driven by `entities.json`, which `ref.py`
writes from Python's `html.entities.html5` — the same HTML5 named character
reference table a browser uses, so decoding matches on both sides.
