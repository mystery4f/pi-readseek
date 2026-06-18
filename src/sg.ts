import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import { stat as fsStat } from "node:fs/promises";
import { defineToolPromptMetadata } from "./tool-prompt-metadata.js";
import { buildReadseekLineWithHash, buildToolErrorResult, type ReadseekLine } from "./readseek-value.js";
import { resolveToCwd } from "./path-utils.js";
import { isReadseekAvailable, readseekSearch, type ReadseekHashline, type ReadseekSearchFileOutput } from "./readseek-client.js";
import { buildSgOutput } from "./sg-output.js";

import { clampLineToWidth, renderAnchoredFilesResult, renderToolLabel } from "./tui-render-utils.js";

type SgParams = { pattern: string; lang?: string; path?: string; cached?: boolean; others?: boolean; ignored?: boolean };

export interface SgRange {
  startLine: number;
  endLine: number;
}

export interface SgEnclosingSymbol {
  name: string;
  kind: string;
}

export function mergeRanges(ranges: SgRange[]): SgRange[] {
  if (ranges.length === 0) return [];
  if (ranges.length === 1) return [{ ...ranges[0] }];

  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const merged: SgRange[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.startLine <= last.endLine + 2) {
      last.endLine = Math.max(last.endLine, current.endLine);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

const SG_PROMPT_METADATA = defineToolPromptMetadata({
  promptUrl: new URL("../prompts/sg.md", import.meta.url),
  promptSnippet: "Search code structurally with readseek and return edit-ready anchors",
});

export function isSgAvailable(): boolean {
  return isReadseekAvailable();
}

interface SgToolOptions {
  onFileAnchored?: (absolutePath: string) => void;
}

/**
 * Inputs for executing the structural search tool without registering it.
 */
export interface ExecuteSgOptions {
  params: unknown;
  signal: AbortSignal | undefined;
  cwd: string;
  onFileAnchored?: (absolutePath: string) => void;
}

function readseekLineFromSearch(line: ReadseekHashline): ReadseekLine {
  return buildReadseekLineWithHash(line.line, line.hash, line.text);
}

function linesFromSearchResult(result: ReadseekSearchFileOutput, ranges: SgRange[]): ReadseekLine[] {
  const lineMap = new Map<number, ReadseekLine>();
  for (const match of result.matches) {
    for (const line of match.hashlines) {
      lineMap.set(line.line, readseekLineFromSearch(line));
    }
  }

  const lines: ReadseekLine[] = [];
  const seen = new Set<number>();
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line++) {
      if (seen.has(line)) continue;
      const readseekLine = lineMap.get(line);
      if (!readseekLine) continue;
      seen.add(line);
      lines.push(readseekLine);
    }
  }
  return lines;
}

function readseekLanguageForPath(language: string | undefined, searchPath: string, isFile: boolean): string | undefined {
  if (language === "typescript" && isFile && path.extname(searchPath).toLowerCase() === ".tsx") return "tsx";
  return language;
}

/**
 * Executes structural search and returns readseek-anchored matches.
 */
export async function executeSg(opts: ExecuteSgOptions): Promise<any> {
  const { params, signal, cwd, onFileAnchored } = opts;
  const p = params as SgParams;
  if (p.ignored && !p.others) {
    const message = "Error: search parameter 'ignored' requires 'others'";
    return buildToolErrorResult("search", "invalid-parameter", message);
  }
  const searchPath = resolveToCwd(p.path ?? ".", cwd);
  let searchPathIsFile = false;

  try {
    const stat = await fsStat(searchPath);
    searchPathIsFile = stat.isFile();
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      const message = `Error: path '${p.path ?? "."}' does not exist`;
      return buildToolErrorResult("search", "path-not-found", message, { path: p.path ?? searchPath });
    }
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      const message = `Error: permission denied for path '${p.path ?? "."}'`;
      return buildToolErrorResult("search", "permission-denied", message, { path: p.path ?? searchPath });
    }
    const message = `Error: could not access path '${p.path ?? "."}': ${err?.message ?? String(err)}`;
    return buildToolErrorResult("search", "fs-error", message, { path: p.path ?? searchPath, details: { fsCode: err?.code, fsMessage: err?.message } });
  }

  try {
    const effectiveLang = readseekLanguageForPath(p.lang, searchPath, searchPathIsFile);
    const results = await readseekSearch(searchPath, p.pattern, {
      language: effectiveLang,
      cached: p.cached,
      others: p.others,
      ignored: p.ignored,
      signal,
    });
    if (results.length === 0) {
      const emptyOutput = buildSgOutput({ pattern: p.pattern, files: [] });
      return {
        content: [{ type: "text", text: emptyOutput.text }],
        details: {
          readseekValue: emptyOutput.readseekValue,
        },
      };
    }

    const readseekFiles: Array<{
      displayPath: string;
      path: string;
      ranges: SgRange[];
      lines: ReadseekLine[];
      symbols?: SgEnclosingSymbol[];
    }> = [];

    for (const result of results) {
      const abs = path.isAbsolute(result.file) ? result.file : path.resolve(cwd, result.file);
      const display = path.relative(cwd, abs) || abs;
      const ranges = result.matches.map((match) => ({ startLine: match.start_line, endLine: match.end_line }));
      const mergedRanges = mergeRanges(ranges);
      const lines = linesFromSearchResult(result, mergedRanges);
      if (lines.length === 0) continue;
      readseekFiles.push({
        displayPath: display,
        path: abs,
        ranges: mergedRanges.map((range) => ({ ...range })),
        lines,
      });
    }

    if (readseekFiles.length === 0) {
      const emptyOutput = buildSgOutput({ pattern: p.pattern, files: [] });
      return {
        content: [{ type: "text", text: emptyOutput.text }],
        details: {
          readseekValue: emptyOutput.readseekValue,
        },
      };
    }

    const builtOutput = buildSgOutput({
      pattern: p.pattern,
      files: readseekFiles,
    });
    for (const readseekFile of readseekFiles) {
      onFileAnchored?.(readseekFile.path);
    }
    return {
      content: [{ type: "text", text: builtOutput.text }],
      details: {
        readseekValue: builtOutput.readseekValue,
      },
    };
  } catch (err: any) {
    const message = String(err?.message || err);
    const missingReadseek = err?.code === "ENOENT" || /Cannot find package|Cannot find module|no such file/i.test(message);
    return buildToolErrorResult(
      "search",
      missingReadseek ? "readseek-not-installed" : "readseek-execution-error",
      message,
      missingReadseek ? { hint: "Run npm install to install @jarkkojs/readseek." } : {},
    );
  }
}

export function registerSgTool(pi: ExtensionAPI, options: SgToolOptions = {}) {
  const toolConfig = {
    callable: true,
    enabled: true,
    policy: "read-only" as const,
    readOnly: true,
    pythonName: "search",
    defaultExposure: "opt-in" as const,
  };

  const tool = {
    name: "search",
    label: "Structural Search",
    description: SG_PROMPT_METADATA.description,
    promptSnippet: SG_PROMPT_METADATA.promptSnippet,
    promptGuidelines: SG_PROMPT_METADATA.promptGuidelines,
    parameters: Type.Object({
      pattern: Type.String({ description: "AST pattern" }),
      lang: Type.Optional(Type.String({ description: "Language hint" })),
      path: Type.Optional(Type.String({ description: "Search path" })),
      cached: Type.Optional(Type.Boolean({ description: "In a Git repository, search tracked/indexed files" })),
      others: Type.Optional(Type.Boolean({ description: "In a Git repository, search untracked files" })),
      ignored: Type.Optional(Type.Boolean({ description: "With others=true, include ignored untracked files" })),
    }),
    ptc: toolConfig,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeSg({ params, signal, cwd: ctx.cwd, onFileAnchored: options.onFileAnchored });
    },
    renderCall(args: any, theme: any, ...rest: any[]) {
      const context = rest[0] ?? {};
      let text = `${renderToolLabel(theme, "search")} ${theme.fg("accent", `/${args.pattern}/`)}`;
      text += theme.fg("dim", ` in ${args.path ?? "."}`);
      if (args.lang) text += theme.fg("dim", ` (${args.lang})`);
      const flags = [args.cached && "cached", args.others && "others", args.ignored && "ignored"].filter(Boolean);
      if (flags.length > 0) text += theme.fg("dim", ` [${flags.join(",")}]`);
      return new Text(clampLineToWidth(text, context.width), 0, 0);
    },
    renderResult(result: any, options: ToolRenderResultOptions, theme: any, ...rest: any[]) {
      return renderAnchoredFilesResult(result, options, theme, rest, {
        pendingLabel: "pending search",
        emptyLabel: "no matches",
        unitSingular: "match",
        unitPlural: "matches",
      });
    },
  } satisfies Parameters<ExtensionAPI["registerTool"]>[0] & { ptc: typeof toolConfig };

  pi.registerTool(tool);
  return tool;
}
