---
tools: hover
---

Use hover to identify the identifier and enclosing symbol at a cursor
position. Calls `readseek identify` with the file content sent via stdin
so unsaved editor content is included.

## Parameters

- `path` (required): File path.
- `line` (required): One-based cursor line.
- `column` (optional): One-based cursor byte column.

## When to use

- Before a rename, to confirm the identifier under the cursor.
- Before a go-to-definition, to get the qualified symbol name.
- To inspect what symbol a specific line belongs to.
