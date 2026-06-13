# pi-readseek

`pi-readseek` is a pi extension for readseek-backed file reading, hash-anchored
editing, anchored grep, structural maps, symbol lookup, and structural search.
It exists to resolve conflicts between overlapping pi file-operation tools by
exposing one consistent readseek-centered surface.

## Installation

```bash
pi install npm:pi-readseek
```

## Tools

- `read` — reads text files with `LINE:HASH` anchors for later `edit` calls;
  images are returned as attachments. Large or symbol-scoped reads can include
  structural maps powered by `@jarkkojs/readseek`.
- `edit` — changes existing text files using fresh anchors from `read`, `grep`,
  `search`, or `write`. Use anchored variants such as `set_line`; `new_text`
  must be plain replacement text and never include `LINE:HASH|` prefixes.
  Set `new_text` to `""` to delete a line. Fuzzy replacement is literal
  relocation, not approximate or semantic matching.
- `grep` — searches text and returns edit-ready `LINE:HASH` anchors without a
  follow-up `read`.
- `search` — searches code by structural pattern and returns anchored
  matches; use it when syntax matters more than raw text.
- `write` — creates or overwrites whole files and returns anchors for immediate
  follow-up edits. Create a new file with `write` when there is no existing file
  to edit.
- `ls` — lists one directory.
- `find` — recursively discovers files and directories.

## Licensing

`pi-readseek` is licensed under `MIT`. See [LICENSE](LICENSE) for more
information.

The upstream `@jarkkojs/readseek` packages are licensed separately as
`Apache-2.0 AND LGPL-2.1-or-later`.

`readseek` is originally derived from the source code of
[`pi-hashline-readmap`](https://github.com/coctostan/pi-hashline-readmap).
The relevant copyrights have been retained in [LICENSE](LICENSE).
