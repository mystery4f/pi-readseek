---
tools: def
---

Find structural symbol definitions. Calls `readseek def` which searches
for the definition of a named symbol across a file or directory.

## Parameters

- `path` (optional): File or directory to search (default: ".").
- `name` (optional): Qualified or unqualified symbol name. Required unless
  `fromIdentify` is true.
- `lang` (optional): Language override.
- `fromIdentify` (optional): When true, reads identify output from a
  previous identify call to extract the symbol name automatically.
- `cached` (optional): Search tracked/indexed files in a Git repository.
- `others` (optional): Search untracked files.
- `ignored` (optional): Include ignored untracked files.

## When to use

- After a hover call, to jump to where a symbol is defined.
- When the user asks "where is X defined?".
- To find a function/class/type definition by its qualified name.
