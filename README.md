# pi-readseek

`pi-readseek` is a pi extension for readseek-backed file reading, hash-anchored
editing, anchored grep, structural maps, symbol lookup, and structural search.
It resolves conflicts between overlapping pi file-operation tools by exposing
one consistent readseek-centered surface.

## Installation

```bash
pi install npm:pi-readseek
```

The structural search and map features require the `@jarkkojs/readseek` native
binary. The extension auto-installs the correct platform package, or you can
install it manually:

```bash
# Auto-installed by the extension on supported platforms.
# Manual install (if needed):
npm install --save-dev @jarkkojs/readseek
```

## Tools

- **read** — reads text files with `LINE:HASH` anchors for later `edit` calls;
  images are returned as attachments and may include local OCR, caption, and
  object text. Supports `symbol`, `map`, and `bundle` options powered by
  `@jarkkojs/readseek`.
- **read_many** — reads multiple files (or per-file `offset`/`limit` ranges) in
  one call. Each file is grouped under a section header with the same
  `LINE:HASH` anchors as `read`, combined under a shared output budget with
  adaptive packing. Images and binary files are summarized in text.
- **edit** — changes existing text files using fresh anchors from `read`,
  `grep`, `search`, or `write`. Variants: `set_line`, `replace_lines`,
  `insert_after`, `replace_symbol`, `replace`. Set `new_text` to `""` to
  delete a line.
- **grep** — searches text and returns edit-ready `LINE:HASH` anchors without a
  follow-up `read`.
- **search** — searches code by structural pattern (AST) and returns anchored
  matches. Use when syntax matters more than raw text.
- **refs** — finds binding-accurate references to an identifier and returns
  anchored usages with their enclosing symbols. Use before renaming or deleting
  a symbol.
- **write** — creates or overwrites whole files and returns anchors for
  immediate follow-up edits.

## Settings

`pi-readseek` reads optional JSON settings from:

| Location | Scope |
| --- | --- |
| `~/.pi/agent/readseek/settings.json` | Global |
| `.pi/readseek/settings.json` | Project |

Project settings override global settings. Image OCR behavior is controlled by
`read.ocrMode`:

```json
{
  "read": {
    "ocrMode": "on"
  }
}
```

Modes:

- `"on"` — always run local image OCR/caption/object analysis. This is the
  default.
- `"off"` — return only the image attachment. Use this as a workaround if the
  local readseek image-analysis path crashes.
- `"auto"` — run local image analysis only when the active model does not
  support native image input.

`READSEEK_READ_OCR_MODE=on|off|auto` overrides the JSON setting for one
process.

## Related

- [readseek.vim](https://github.com/jarkkojs/readseek.vim) — Vim 9 plugin
  frontend for the readseek CLI. Provides go-to-definition, references,
  rename, hover, and structural search from within Vim.

## Licensing

`pi-readseek` is licensed under `MIT`. See [LICENSE](LICENSE) for more
information.

The upstream `@jarkkojs/readseek` packages are licensed separately as
`Apache-2.0 AND LGPL-2.1-or-later`.
