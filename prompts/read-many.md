Read multiple files in one call with per-file `offset` / `limit` or `symbol`. Each file's text output uses the same `LINE:HASH|content` anchors as `read`, grouped under a per-file section header, so anchors can be copied directly into `edit`. When a `symbol` is given the read range is narrowed to that symbol and a `[Symbol: ...]` banner is prefixed. Images and other binary files are summarized in text (no attachment). Default combined cap: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}.

## When to use read_many vs read

- **read_many**: pull several small-to-medium files (or targeted ranges) into context in a single round-trip.
- **read**: single files that need `map`, `bundle`, image attachments, or OCR — none of which read_many supports.

## Parameters

- `files` — array (1–26 entries), order is the render order. Each entry:
  - `path` — file path (relative or absolute).
  - `offset` / `limit` — optional positive integers; `offset` is 1-indexed. Omit both for the whole file.
- `symbol` — symbol query; supports `Class.method`, package-relative Java names, and `Name@<line>` disambiguation; cannot combine with `offset` / `limit`. When a symbol is matched the header shows `[Symbol: name (kind)]` and the range is narrowed to its definition.
- `stopOnError` — default `false`. When `true`, reading stops at the first file error and earlier results are still returned.

## Symbol examples

| Query | Reads |
|---|---|
| `{ "symbol": "processEvent" }` | function or top-level symbol |
| `{ "symbol": "EventEmitter" }` | class/interface/type/enum/etc. |
| `{ "symbol": "EventEmitter.emit" }` | child method/member |
| `{ "symbol": "Foo.bar@42" }` | overload/definition near line 42 |

## Output format

Each file is rendered under a `--- <path> (lines START-END of TOTAL) ---` header followed by anchored lines. A file that errors is shown as `--- <path> ---` followed by an `[Error: ...]` line, and the remaining files are still read (unless `stopOnError`).

## Packing

Under the combined output budget, read_many packs adaptively: by default files are kept in strict request order, but if a smallest-first selection fits strictly more complete files, that selection is used while the rendered order stays the original request order. Files that do not fit are listed in a trailing `[Omitted: ...]` note — re-read them individually with `read` or narrow their `offset` / `limit`.

Hash anchors from read_many are valid for `edit` until the file changes.