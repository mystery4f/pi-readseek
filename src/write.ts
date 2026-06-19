import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { resolveToCwd } from "./path-utils.js";
import { ensureHashInit, formatHashlineDisplay } from "./hashline.js";
import { buildReadseekError, buildReadseekLine, buildReadseekWarning, type ReadseekLine, type ReadseekWarning } from "./readseek-value.js";
import { looksLikeBinary } from "./binary-detect.js";
import { getOrGenerateMap } from "./map-cache.js";
import { formatFileMapWithBudget } from "./readseek/formatter.js";

import { defineToolPromptMetadata } from "./tool-prompt-metadata.js";
import { buildPendingWritePreviewData, buildWritePreviewKey, resolvePendingDiffPreview, type PendingDiffPreviewResult } from "./pending-diff-preview.js";
import { generateCompactOrFullDiff, normalizeToLF, hasBareCarriageReturn } from "./edit-diff.js";
import { buildDiffData, type DiffData } from "./diff-data.js";
import { clampLineToWidth, clampLinesToWidth, isRendererExpanded, linkToolPath, renderErrorResult, renderToolLabel, summaryLine } from "./tui-render-utils.js";
import { DiffPreviewComponent } from "./tui-diff-component.js";
import type { FileAnchoredCallback } from "./tool-types.js";
import { registerReadseekTool } from "./register-tool.js";

const WRITE_PENDING_PREVIEW_STATE_KEY = "hashline-write-pending-preview";

const CONTENT_PREVIEW_MAX_LINES = 200;

function formatContentPreviewLines(content: string, theme: any): string[] {
  const lines = content.split("\n");
  // Drop the single trailing blank produced by a terminal newline so the
  // preview reads naturally.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const shown = lines.slice(0, CONTENT_PREVIEW_MAX_LINES);
  // Right-align line numbers so the body has a stable column for the content.
  // The dim gutter ("  N │ ") visually distinguishes the body from the
  // "↳ created / pending create" header above it without re-introducing
  // diff chrome (no +/- marker, no red/green tint).
  const width = String(shown.length).length;
  // Bind theme.fg so we keep its `this` (the Theme uses internal state); fall back
  // to an identity tint when no theme is provided (e.g. in tests).
  const fg = typeof theme?.fg === "function" ? (style: string, text: string) => theme.fg(style, text) : (_style: string, text: string) => text;
  const formatted = shown.map((line, index) => {
    const gutter = fg("dim", `${String(index + 1).padStart(width, " ")} │ `);
    return `  ${gutter}${line}`;
  });
  if (lines.length > CONTENT_PREVIEW_MAX_LINES) {
    formatted.push(`  ${fg("dim", `… ${lines.length - CONTENT_PREVIEW_MAX_LINES} more lines not shown`)}`);
  }
  return formatted;
}

function pendingWritePreviewParts(summary: string, preview: PendingDiffPreviewResult | undefined, expanded: boolean, theme: any): { lines: string[]; diffData?: DiffData } {
  if (!preview || preview.type !== "ok") return { lines: summary.split("\n") };
  // Pure creates (write to a new file) have no "old" side, so a diff-shaped
  // preview is just noise. Show the new file's content with a dim gutter of
  // line numbers when expanded; otherwise just a Ctrl+O hint.
  const hasOldSide = preview.data.fileExistedBeforeWrite;
  const headerLine = summaryLine(preview.data.headerLabel, { hidden: !expanded });
  if (!hasOldSide) {
    const lines = [summary, headerLine];
    if (expanded) lines.push(...formatContentPreviewLines(preview.data.nextContent, theme));
    return { lines };
  }
  const diffData = buildDiffData({ path: preview.data.filePath, oldContent: preview.data.previousContent, newContent: preview.data.nextContent, diff: preview.data.diff });
  return { lines: [summary, headerLine], diffData: expanded ? diffData : undefined };
}

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const WRITE_PROMPT_METADATA = defineToolPromptMetadata({
  promptUrl: new URL("../prompts/write.md", import.meta.url),
  promptSnippet: "Create or overwrite a complete file and return edit anchors",
});

type WriteDiffFields = {
  diff?: string;
  diffData?: DiffData;
};

export interface WriteResult extends WriteDiffFields {
  text: string;
  warnings: string[];
  writeState?: "created" | "overwritten";
  readseekValue: {
    tool: "write";
    path: string;
    lines: ReadseekLine[];
    warnings: ReadseekWarning[];
    diff?: string;
    diffData?: DiffData;
    map?: { appended: boolean };
  };
}

function readPreviousTextForDiff(filePath: string): string {
  try {
    if (!existsSync(filePath)) return "";
    const previous = readFileSync(filePath);
    if (looksLikeBinary(previous)) return "";
    return previous.toString("utf-8");
  } catch {
    return "";
  }
}

function generateWriteDiff(previousContent: string, nextContent: string): { diff: string; firstChangedLine: number | undefined } {
  if (previousContent !== "") return generateCompactOrFullDiff(previousContent, nextContent);
  const normalizedNext = normalizeToLF(nextContent);
  if (normalizedNext === "") return { diff: "", firstChangedLine: undefined };
  const lines = normalizedNext.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const width = String(lines.length).length;
  return {
    diff: lines.map((line, index) => `+${String(index + 1).padStart(width, " ")} ${line}`).join("\n"),
    firstChangedLine: 1,
  };
}

export interface WriteToolOptions {
  onFileAnchored?: FileAnchoredCallback;
}

type MappedFsError = {
  code: "permission-denied" | "path-is-directory" | "fs-error";
  message: string;
  includeMeta: boolean;
};

function mapFsWriteError(err: any, path: string): MappedFsError {
  const phase: "mkdir" | "write" | undefined = err?.__phase;
  const fsCode = err?.code as string | undefined;

  if (fsCode === "EACCES" || fsCode === "EPERM") {
    return {
      code: "permission-denied",
      message: `Permission denied — cannot write: ${path}`,
      includeMeta: false,
    };
  }
  if (fsCode === "EISDIR") {
    return {
      code: "path-is-directory",
      message: `Path is a directory — cannot overwrite: ${path}`,
      includeMeta: false,
    };
  }
  if (fsCode === "ENOENT" && phase === "mkdir") {
    return {
      code: "fs-error",
      message: `Cannot create parent directories for ${path}: ${err?.message ?? String(err)}`,
      includeMeta: true,
    };
  }
  if (fsCode === "ENOSPC") {
    return {
      code: "fs-error",
      message: `No space left on device — cannot write: ${path}`,
      includeMeta: true,
    };
  }
  if (fsCode === "EROFS") {
    return {
      code: "fs-error",
      message: `Read-only filesystem — cannot write: ${path}`,
      includeMeta: true,
    };
  }
  return {
    code: "fs-error",
    message: `Error writing ${path}: ${err?.message ?? String(err)}`,
    includeMeta: true,
  };
}

function buildWriteFsErrorResult(err: any, absolutePath: string) {
  const mapped = mapFsWriteError(err, absolutePath);
  return {
    content: [{ type: "text" as const, text: mapped.message }],
    isError: true,
    details: {
      readseekValue: {
        tool: "write" as const,
        path: absolutePath,
        lines: [] as ReadseekLine[],
        warnings: [] as ReadseekWarning[],
        ok: false,
        error: buildReadseekError(
          mapped.code,
          mapped.message,
          undefined,
          mapped.includeMeta ? { fsCode: err?.code, fsMessage: err?.message } : undefined,
        ),
      },
      warnings: [] as string[],
    },
  };
}

export async function executeWrite(opts: {
  path: string;
  content: string;
  map?: boolean;
  cwd?: string;
}): Promise<WriteResult> {
  await ensureHashInit();

  const { path: filePath, content, map: requestMap, cwd } = opts;
  const warnings: string[] = [];
  const readseekWarnings: ReadseekWarning[] = [];

  if (hasBareCarriageReturn(content)) {
    const message = "File content contains bare CR (\\r) line endings; write refuses to emit anchors that read/edit would normalize differently.";
    warnings.push(message);
    readseekWarnings.push(buildReadseekWarning("bare-cr", message));
    return {
      text: `Cannot write ${filePath}\n⚠️ ${message}`,
      warnings,
      readseekValue: {
        tool: "write",
        path: filePath,
        lines: [],
        warnings: readseekWarnings,
      },
    };
  }
  const previousContent = readPreviousTextForDiff(filePath);
  const existedBeforeWrite = existsSync(filePath);

  // Create parent directories
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (err: any) {
    err.__phase = "mkdir";
    throw err;
  }
  // Write file
  try {
    writeFileSync(filePath, content, "utf-8");
  } catch (err: any) {
    err.__phase = "write";
    throw err;
  }


  // Binary detection
  if (looksLikeBinary(Buffer.from(content, "utf-8"))) {
    warnings.push("File content appears to be binary.");
    readseekWarnings.push(buildReadseekWarning("binary-content", "File content appears to be binary."));
    return {
      text: `Wrote ${filePath}\n⚠️ File content appears to be binary — hashlines not generated.`,
      warnings,
      readseekValue: {
        tool: "write",
        path: filePath,
        lines: [],
        warnings: readseekWarnings,
      },
    };
  }

  // Compute hashlines
  const rawLines = content.split("\n");
  const readseekLines: ReadseekLine[] = [];
  const displayLines: string[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1;
    const readseekLine = buildReadseekLine(lineNum, rawLines[i]);
    readseekLines.push(readseekLine);
    displayLines.push(formatHashlineDisplay(lineNum, rawLines[i]));
  }

  let text = displayLines.join("\n");
  if (rawLines.length > MAX_LINES) {
    text = displayLines.slice(0, MAX_LINES).join("\n");
    text += `\n[… ${rawLines.length - MAX_LINES} more lines not shown — full anchors in readseekValue]`;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, MAX_BYTES).toString("utf8");
    text += "\n[… output truncated at 50 KB — full anchors in readseekValue]";
  }

  // Optional structural map
  let mapAppended = false;
  if (requestMap) {
    try {
      const fileMap = await getOrGenerateMap(filePath);
      if (fileMap) {
        const mapText = formatFileMapWithBudget(fileMap);
        if (mapText) {
          text += "\n\n" + mapText;
          mapAppended = true;
        }
      }
    } catch {
      // Map generation failure is non-fatal
    }
  }

  const displayPath = cwd ? relative(cwd, filePath) || filePath : filePath;
  const normalizedPrevious = normalizeToLF(previousContent);
  const normalizedNext = normalizeToLF(content);
  const diffResult = generateWriteDiff(normalizedPrevious, normalizedNext);
  const diffData = buildDiffData({
    path: filePath,
    oldContent: normalizedPrevious,
    newContent: normalizedNext,
    diff: diffResult.diff,
  });

  return {
    text,
    warnings,
    writeState: existedBeforeWrite ? "overwritten" : "created",
    diff: diffResult.diff,
    diffData,
    readseekValue: {
      tool: "write",
      path: displayPath,
      lines: readseekLines,
      warnings: readseekWarnings,
      diff: diffResult.diff,
      diffData,
      ...(requestMap ? { map: { appended: mapAppended } } : {}),
    },
  };
}

export function registerWriteTool(pi: ExtensionAPI, options: WriteToolOptions = {}) {
  const tool = registerReadseekTool(pi, {
    policy: "mutating",
    pythonName: "write",
    defaultExposure: "not-safe-by-default",
  }, {
    name: "write",
    label: "write",
    description: WRITE_PROMPT_METADATA.description,
    promptSnippet: WRITE_PROMPT_METADATA.promptSnippet,
    promptGuidelines: WRITE_PROMPT_METADATA.promptGuidelines,
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      content: Type.String({ description: "File content" }),
      map: Type.Optional(Type.Boolean({ description: "Append structural map" })),
    }),
    async execute(_toolCallId: string, params: { path: string; content: string; map?: boolean }, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any): Promise<any> {
      const cwd = ctx?.cwd ?? process.cwd();
      const absolutePath = resolveToCwd(params.path, cwd);
      try {
        return await withFileMutationQueue(absolutePath, async () => {
          let result: WriteResult;
          try {
            result = await executeWrite({
              path: absolutePath,
              content: params.content,
              map: params.map,
              cwd,
            });
          } catch (err: any) {
            return buildWriteFsErrorResult(err, absolutePath);
          }

          if (result.readseekValue.lines.length > 0) {
            options.onFileAnchored?.(absolutePath);
          }

          // Lift binary-content signal into a fatal readseekValue.error envelope so
          // downstream consumers get the same taxonomy shape as every other tool.
          // The existing ReadseekWarning entry is preserved on readseekValue.warnings for
          // backward compatibility.
          for (const code of ["binary-content", "bare-cr"] as const) {
            const warning = result.readseekValue.warnings.find((w) => w.code === code);
            if (warning) {
              return {
                content: [{ type: "text" as const, text: result.text }],
                isError: true,
                details: {
                  readseekValue: {
                    ...result.readseekValue,
                    ok: false,
                    error: buildReadseekError(code, warning.message),
                  },
                  warnings: result.warnings,
                },
              };
            }
          }

          return {
            content: [{ type: "text" as const, text: result.text }],
            details: {
              ...(result.diff !== undefined ? { diff: result.diff } : {}),
              ...(result.diffData !== undefined ? { diffData: result.diffData } : {}),
              ...(result.writeState ? { writeState: result.writeState } : {}),
              readseekValue: result.readseekValue,
              warnings: result.warnings,
            },
          };
        });
      } catch (err: any) {
        return buildWriteFsErrorResult(err, absolutePath);
      }
    },
    renderCall(args: any, theme: any, context: any = {}) {
      const { path, content } = args as { path: string; content?: string };
      const cwd = context.cwd ?? process.cwd();
      const label = renderToolLabel(theme, "write");
      const lineCount = typeof content === "string" ? content.split("\n").length : 0;
      const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
      const renderedPath = typeof path === "string"
        ? linkToolPath(theme.fg("muted", path), path, cwd)
        : theme.fg("toolOutput", "...");
      let text = clampLineToWidth(`${label} ${renderedPath}${typeof content === "string" ? ` (${lineCount} ${lineCount === 1 ? "line" : "lines"} • ${bytes} B)` : ""}`, context.width);
      // Once execution has started, the pending preview's only job is done:
      // renderResult will carry the story ("↳ created" / "↳ overwritten" with
      // expandable content or diff). Showing the "↳ pending…" sub-line and
      // its preview alongside the final result is just duplicate noise — the
      // pre-execution state can no longer change in any meaningful way.
      if (context.executionStarted) {
        const textComponent = (context.lastComponent && !(context.lastComponent instanceof DiffPreviewComponent))
          ? context.lastComponent
          : new Text("", 0, 0);
        textComponent.setText(text);
        return textComponent;
      }
      const previewKey = buildWritePreviewKey(args ?? {});
      const preview = resolvePendingDiffPreview(context, WRITE_PENDING_PREVIEW_STATE_KEY, previewKey, () => buildPendingWritePreviewData(args ?? {}, context.cwd ?? process.cwd()));
      const expanded = !!context.expanded;
      const parts = pendingWritePreviewParts(text, preview, expanded, theme);
      if (parts.diffData) {
        const diffComponent = context.lastComponent instanceof DiffPreviewComponent
          ? context.lastComponent
          : new DiffPreviewComponent({ prefixLines: parts.lines, diffData: parts.diffData, theme, expanded: true });
        diffComponent.update({ prefixLines: parts.lines, diffData: parts.diffData, theme, expanded: true });
        return diffComponent;
      }
      const textComponent = (context.lastComponent && !(context.lastComponent instanceof DiffPreviewComponent))
        ? context.lastComponent
        : new Text("", 0, 0);
      textComponent.setText(clampLinesToWidth(parts.lines, context.width).join("\n"));
      return textComponent;
    },
    renderResult(result: any, options: any, theme: any, context: any = {}) {
      const expanded = isRendererExpanded(options, context);
      const width = context.width ?? options?.width;
      const details = result.details ?? {};
      const output = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      if (result.isError || details.readseekValue?.ok === false) {
        return renderErrorResult(output, { expanded, width, fallback: "write failed" });
      }
      const diffData = details.diffData;
      const state = details.writeState === "overwritten" ? "overwritten" : "created";
      // Pure creates: render the new file's contents on expand (no diff chrome)
      // instead of a diff body — every line is an add, so the gutter, line
      // numbers, and red/green tinting are noise.
      if (state === "created") {
        const readseekLines = (details.readseekValue?.lines ?? []) as Array<{ raw: string }>;
        const hasContent = readseekLines.length > 0;
        const header = summaryLine(state, { hidden: hasContent && !expanded });
        const lines = header.split("\n");
        if (expanded && hasContent) {
          const content = readseekLines.map((l) => l.raw).join("\n");
          lines.push(...formatContentPreviewLines(content, theme));
        }
        return new Text(clampLinesToWidth(lines, width).join("\n"), 0, 0);
      }
      // Overwrite: the old vs new comparison still carries signal — keep the diff UI.
      const hasExpandableDiff = !!diffData;
      let text = summaryLine(state, { hidden: hasExpandableDiff && !expanded });
      if (expanded && hasExpandableDiff) {
        const diffComponent = context.lastComponent instanceof DiffPreviewComponent
          ? context.lastComponent
          : new DiffPreviewComponent({ prefixLines: text.split("\n"), diffData, theme, expanded: true });
        diffComponent.update({ prefixLines: text.split("\n"), diffData, theme, expanded: true });
        return diffComponent;
      }
      return new Text(clampLinesToWidth(text.split("\n"), width).join("\n"), 0, 0);
    },
  });
  return tool;
}
