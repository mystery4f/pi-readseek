import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import { stat as fsStat } from "node:fs/promises";
import { defineToolPromptMetadata } from "./tool-prompt-metadata.js";
import { escapeControlCharsForDisplay } from "./hashline.js";
import { buildReadseekError, type ReadseekLine } from "./readseek-value.js";
import { resolveToCwd } from "./path-utils.js";
import { isReadseekAvailable, readseekSearch, type ReadseekHashline, type ReadseekSearchFileOutput } from "./readseek-client.js";
import { buildSgOutput } from "./sg-output.js";

import { clampLineToWidth, clampLinesToWidth, isRendererExpanded, renderToolLabel, summaryLine } from "./tui-render-utils.js";

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
  promptGuidelines: [
    "Use search when text search is too broad or brittle and the query depends on code shape.",
    "Use search for calls, imports, declarations, JSX, and similar syntax patterns.",
    "Use grep instead of search for plain text search.",
  ],
});

export function isSgAvailable(): boolean {
  return isReadseekAvailable();
}

interface SgToolOptions {
  onFileAnchored?: (absolutePath: string) => void;
}

function readseekLineFromSearch(line: ReadseekHashline): ReadseekLine {
  return {
    line: line.line,
    hash: line.hash,
    anchor: `${line.line}:${line.hash}`,
    raw: line.text,
    display: escapeControlCharsForDisplay(line.text),
  };
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
      const p = params as SgParams;
      if (p.ignored && !p.others) {
        const message = "Error: search parameter 'ignored' requires 'others'";
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: {
            readseekValue: {
              tool: "search",
              ok: false,
              error: buildReadseekError("invalid-parameter", message),
            },
          },
        };
      }
      const searchPath = resolveToCwd(p.path ?? ".", ctx.cwd);
      let searchPathIsFile = false;

      try {
        const stat = await fsStat(searchPath);
        searchPathIsFile = stat.isFile();
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          const message = `Error: path '${p.path ?? "."}' does not exist`;
          return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: {
              readseekValue: {
                tool: "search",
                ok: false,
                path: p.path ?? searchPath,
                error: buildReadseekError("path-not-found", message),
              },
            },
          };
        }
        if (err?.code === "EACCES" || err?.code === "EPERM") {
          const message = `Error: permission denied for path '${p.path ?? "."}'`;
          return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: {
              readseekValue: {
                tool: "search",
                ok: false,
                path: p.path ?? searchPath,
                error: buildReadseekError("permission-denied", message),
              },
            },
          };
        }
        const message = `Error: could not access path '${p.path ?? "."}': ${err?.message ?? String(err)}`;
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: {
            readseekValue: {
              tool: "search",
              ok: false,
              path: p.path ?? searchPath,
              error: buildReadseekError("fs-error", message, undefined, { fsCode: err?.code, fsMessage: err?.message }),
            },
          },
        };
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
          const abs = path.isAbsolute(result.file) ? result.file : path.resolve(ctx.cwd, result.file);
          const display = path.relative(ctx.cwd, abs) || abs;
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
          options.onFileAnchored?.(readseekFile.path);
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
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: {
            readseekValue: {
              tool: "search",
              ok: false,
              error: missingReadseek
                ? buildReadseekError("readseek-not-installed", message, "Run npm install to install @jarkkojs/readseek.")
                : buildReadseekError("readseek-execution-error", message),
            },
          },
        };
      }
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
      const context: { isPartial?: boolean; isError?: boolean; expanded?: boolean; cwd?: string; width?: number } =
        rest[0] ?? options ?? {};
      const isPartial = context.isPartial ?? (options as any)?.isPartial ?? false;
      const isError = context.isError ?? false;
      const expanded = isRendererExpanded(options as any, context as any);
      const cwd = context.cwd ?? process.cwd();
      const width = (context as any).width ?? (options as any)?.width;

      if (isPartial) return new Text(clampLinesToWidth([summaryLine("pending search")], width).join("\n"), 0, 0);

      const content = result.content?.[0];
      const textContent = content?.type === "text" ? content.text : "";
      if (isError || result.isError) {
        const firstLine = textContent.split("\n")[0] || "Error";
        const body = expanded && textContent ? textContent : firstLine;
        return new Text(clampLinesToWidth(summaryLine(body).split("\n"), width).join("\n"), 0, 0);
      }
      const readseekValue = (result.details as any)?.readseekValue as
        | { tool: "search"; files: Array<{ path: string; lines: any[] }> }
        | undefined;
      const files = readseekValue?.files ?? [];
      if (files.length === 0) return new Text(summaryLine("no matches"), 0, 0);
      const fileCount = files.length;
      const totalMatches = files.reduce((sum: number, f: any) => sum + f.lines.length, 0);
      const matchWord = totalMatches === 1 ? "match" : "matches";
      const fileWord = fileCount === 1 ? "file" : "files";
      let text = summaryLine(`${totalMatches} ${matchWord} in ${fileCount} ${fileWord}`, { hidden: files.length > 0 && !expanded });
      if (expanded) {
        for (const file of files.slice(0, 20)) {
          const display = path.relative(cwd, file.path) || file.path;
          text += "\n" + theme.fg("dim", `  ${display} (${file.lines.length})`);
        }
        if (files.length > 20) text += "\n" + theme.fg("muted", `  … and ${files.length - 20} more files`);
      }
      return new Text(clampLinesToWidth(text.split("\n"), width).join("\n"), 0, 0);
    },
  } satisfies Parameters<ExtensionAPI["registerTool"]>[0] & { ptc: typeof toolConfig };

  pi.registerTool(tool);
  return tool;
}
