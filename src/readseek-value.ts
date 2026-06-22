import { computeLineHash, escapeControlCharsForDisplay } from "./hashline.js";
import type { DiffData } from "./diff-data.js";

export interface ReadseekLine {
  line: number;
  hash: string;
  anchor: string;
  raw: string;
  display: string;
}

export interface ReadseekWarningSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  parentName?: string;
}
export interface ReadseekWarning {
  code: string;
  message: string;
  tier?: "camelCase" | "substring";
  symbol?: ReadseekWarningSymbol;
  otherCandidates?: ReadseekWarningSymbol[];
}

export interface ReadseekError {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

export interface ReadseekRange {
  startLine: number;
  endLine: number;
  totalLines?: number;
}

export interface SemanticSummary {
  classification: "no-op" | "whitespace-only" | "semantic" | "mixed";
  difftasticAvailable: boolean;
  movedBlocks?: number;
}
export interface ReadseekEditResult {
  tool: "edit";
  ok: boolean;
  path: string;
  summary: string;
  diff: string;
  diffData?: DiffData;
  firstChangedLine: number | undefined;
  warnings: string[];
  noopEdits: unknown[];
  semanticSummary?: SemanticSummary;
}

/**
 * Build a {@link ReadseekLine} from an already-known hash. Use this when the
 * hash is supplied by readseek (search, refs) rather than computed from `raw`;
 * {@link buildReadseekLine} delegates here after hashing.
 */
export function buildReadseekLineWithHash(line: number, hash: string, raw: string): ReadseekLine {
  return {
    line,
    hash,
    anchor: `${line}:${hash}`,
    raw,
    display: escapeControlCharsForDisplay(raw),
  };
}

export function buildReadseekLine(line: number, raw: string): ReadseekLine {
  return buildReadseekLineWithHash(line, computeLineHash(raw), raw);
}

export function buildReadseekLines(startLine: number, rawLines: string[]): ReadseekLine[] {
  return rawLines.map((raw, index) => buildReadseekLine(startLine + index, raw));
}

function renderReadseekLine(line: ReadseekLine): string {
  return `${line.anchor}|${line.display}`;
}

export function renderReadseekLines(lines: ReadseekLine[]): string {
  return lines.map(renderReadseekLine).join("\n");
}

export function buildReadseekWarning(
  code: string,
  message: string,
  metadata: Omit<ReadseekWarning, "code" | "message"> = {},
): ReadseekWarning {
  return { code, message, ...metadata };
}

export function buildReadseekError(
  code: string,
  message: string,
  hint?: string,
  details?: unknown,
): ReadseekError {
  return {
    code,
    message,
    ...(hint !== undefined ? { hint } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

export interface ToolErrorResult {
  content: [{ type: "text"; text: string }];
  isError: true;
  details: { readseekValue: Record<string, unknown> };
}

/**
 * Build the standard failure envelope shared by every read-family tool: a text
 * content block plus a `readseekValue` carrying `ok: false` and a
 * {@link buildReadseekError} payload.
 *
 * `path` is included only when provided, and `extra` is merged into
 * `readseekValue` so callers can attach tool-specific fields (e.g. write's
 * `lines`/`warnings`).
 */
export function buildToolErrorResult(
  tool: string,
  code: string,
  message: string,
  opts: { path?: string; hint?: string; details?: unknown; extra?: Record<string, unknown> } = {},
): ToolErrorResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: {
      readseekValue: {
        tool,
        ...(opts.extra ?? {}),
        ok: false,
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        error: buildReadseekError(code, message, opts.hint, opts.details),
      },
    },
  };
}

export function buildReadseekEditResult(input: {
  ok?: boolean;
  path: string;
  summary: string;
  diff: string;
  diffData?: DiffData;
  firstChangedLine: number | undefined;
  warnings: string[];
  noopEdits: unknown[];
  semanticSummary?: SemanticSummary;
}): ReadseekEditResult {
  return {
    tool: "edit",
    ok: input.ok ?? true,
    path: input.path,
    summary: input.summary,
    diff: input.diff,
    ...(input.diffData ? { diffData: input.diffData } : {}),
    firstChangedLine: input.firstChangedLine,
    warnings: [...input.warnings],
    noopEdits: [...input.noopEdits],
    ...(input.semanticSummary ? { semanticSummary: input.semanticSummary } : {}),
  };
}
