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
  images are returned as attachments. Supports `symbol`, `map`, and `bundle`
  options powered by `@jarkkojs/readseek`.
- **edit** — changes existing text files using fresh anchors from `read`,
  `grep`, `search`, or `write`. Variants: `set_line`, `replace_lines`,
  `insert_after`, `replace_symbol`, `replace`. Set `new_text` to `""` to
  delete a line.
- **grep** — searches text and returns edit-ready `LINE:HASH` anchors without a
  follow-up `read`.
- **search** — searches code by structural pattern (AST) and returns anchored
  matches. Use when syntax matters more than raw text.
- **write** — creates or overwrites whole files and returns anchors for
  immediate follow-up edits.

## Licensing

`pi-readseek` is licensed under `MIT`. See [LICENSE](LICENSE) for more
information.

The upstream `@jarkkojs/readseek` packages are licensed separately as
`Apache-2.0 AND LGPL-2.1-or-later`.

`readseek` is originally derived from the source code of
[`pi-hashline-readmap`](https://github.com/coctostan/pi-hashline-readmap).
The relevant copyrights have been retained in [LICENSE](LICENSE).
