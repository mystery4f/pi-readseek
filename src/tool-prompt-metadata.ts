import { readFileSync } from "node:fs";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";

const COMPACT_DESCRIPTIONS: Record<string, string> = {
  "read.md": "Read text files/images by path; text has LINE:HASH anchors, images return attachments.",
  "edit.md": "Edit existing text files using fresh LINE:HASH anchors from read, grep, search, or write.",
  "grep.md": "Search file contents; non-summary results include LINE:HASH anchors for edits.",

  "write.md": "Create or overwrite a complete file and return anchors.",
  "sg.md": "Search code by AST pattern and return anchored matches.",
  "refs.md": "Find references to an identifier and return anchored usages with enclosing symbols.",
};

const COMPACT_GUIDELINES: Record<string, string[]> = {
  "read.md": [
    "Use read for file contents, images/screenshots, ranges, symbols, and edit anchors.",
    "Use map or symbol mode before pulling large code files into context.",
    "Use read for images; it returns attachments, so avoid OCR tools unless explicitly needed.",
  ],
  "edit.md": [
    "Use edit with fresh LINE:HASH anchors for existing files.",
    "Prefer set_line, replace_lines, and insert_after; use replace only when anchors are impractical.",
  ],
  "grep.md": [
    "Use grep for text search and edit-ready matching anchors.",
    "Use grep summary mode for broad count/file discovery before narrowing.",
  ],

  "write.md": [
    "Use write to create files or intentionally overwrite whole files.",
    "Use edit rather than write for small changes or appends to existing files.",
  ],
  "sg.md": [
    "Use search for AST-shaped code patterns.",
    "Use grep instead of search for plain text.",
  ],
  "refs.md": [
    "Use refs to find every usage of an identifier before renaming or deleting it.",
    "Use refs with scope plus line/column to follow a specific binding instead of every same-named identifier.",
  ],
};

interface ToolPromptMetadata {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

function loadPrompt(promptUrl: URL): string {
  return readFileSync(promptUrl, "utf-8")
    .replaceAll("{{DEFAULT_MAX_LINES}}", String(DEFAULT_MAX_LINES))
    .replaceAll("{{DEFAULT_MAX_BYTES}}", formatSize(DEFAULT_MAX_BYTES))
    .trim();
}

function firstPromptParagraph(prompt: string): string {
  return prompt.split(/\n\s*\n/, 1)[0]?.trim() ?? prompt;
}

function promptFileName(promptUrl: URL): string {
  return promptUrl.pathname.split("/").pop() ?? "";
}

export function defineToolPromptMetadata(options: {
  promptUrl: URL;
  promptSnippet: string;
}): ToolPromptMetadata {
  const prompt = loadPrompt(options.promptUrl);
  const fileName = promptFileName(options.promptUrl);
  const compactDescription = COMPACT_DESCRIPTIONS[fileName];
  return {
    description: compactDescription ?? firstPromptParagraph(prompt),
    promptSnippet: options.promptSnippet,
    promptGuidelines: COMPACT_GUIDELINES[fileName] ?? [],
  };
}
