import { countEditTypes, parseDiffStats } from "./edit-render-helpers.js";
import { buildReadseekEditResult, type SemanticSummary } from "./readseek-value.js";

import type { DiffData } from "./diff-data.js";
export interface BuildEditOutputInput {
  path: string;
  displayPath: string;
  diff: string;
  patch?: string;
  diffData?: DiffData;
  firstChangedLine: number | undefined;
  warnings: string[];
  noopEdits: unknown[];
  semanticSummary?: SemanticSummary;
  edits?: unknown[];
}
export interface EditOutputResult {
  text: string;
  patch: string;
  readseekValue: ReturnType<typeof buildReadseekEditResult>;
}

const EDIT_OPERATION_NAMES = ["set_line", "replace_lines", "insert_after", "replace"] as const;

type EditOperationName = (typeof EDIT_OPERATION_NAMES)[number];

type EditOperationWithNewText = {
  new_text: string;
};

function hasNewText(value: unknown): value is EditOperationWithNewText {
  return typeof value === "object" && value !== null && typeof (value as { new_text?: unknown }).new_text === "string";
}

function getVisibleDiffStats(diff: string): { added: number; removed: number } {
  const stats = parseDiffStats(diff);
  if (stats.added > 0 || stats.removed > 0) return stats;
  if (!diff.includes("→")) return stats;
  if (diff.includes("→ [deleted]")) return { added: 0, removed: 1 };
  return { added: 1, removed: 1 };
}
function buildVisibleSummary(displayPath: string, diff: string, edits: unknown[] | undefined): string {
  let stats = getVisibleDiffStats(diff);
  const counts = countEditTypes(edits);
  const editCount = counts.total || 1;

  if (
    counts.total > 0 &&
    counts.insert_after === counts.total &&
    stats.removed > 0 &&
    stats.added === stats.removed + counts.insert_after
  ) {
    stats = { added: counts.insert_after, removed: 0 };
  }

  const changeWord = editCount === 1 ? "change" : "changes";
  const changedLineCount = Math.max(stats.added, stats.removed);
  const lineWord = changedLineCount === 1 ? "line" : "lines";
  return `Edited ${displayPath} (${editCount} ${changeWord}, +${stats.added} -${stats.removed} ${lineWord})`;
}
function extractNewTextValues(edits: unknown[] | undefined): string[] {
  const values: string[] = [];
  for (const edit of edits ?? []) {
    if (!edit || typeof edit !== "object") continue;

    const operations = edit as Partial<Record<EditOperationName, unknown>>;
    for (const operationName of EDIT_OPERATION_NAMES) {
      const operation = operations[operationName];
      if (hasNewText(operation)) values.push(operation.new_text);
    }
  }
  return values;
}
function formatWhitespaceOnlyWarning(semanticSummary: SemanticSummary | undefined, edits: unknown[] | undefined): string | undefined {
  if (semanticSummary?.classification !== "whitespace-only") return undefined;
  if (!extractNewTextValues(edits).some((text) => /\S/.test(text))) return undefined;
  return "⚠ Edit classified as whitespace-only — if you intended a behavior change, re-read to verify.";
}
function formatSemanticSuffix(semanticSummary: SemanticSummary | undefined): string {
  if (!semanticSummary) return "";

  const movedBlocks = semanticSummary.movedBlocks ?? 0;
  if (movedBlocks <= 0) return "";

  const blockWord = movedBlocks === 1 ? "block" : "blocks";
  return ` [semantic: ${semanticSummary.classification}, ${movedBlocks} ${blockWord} moved]`;
}
function formatReplaceHint(edits: unknown[] | undefined, noopEdits: unknown[]): string | undefined {
  if ((noopEdits ?? []).length > 0) return undefined;
  const counts = countEditTypes(edits);
  if (counts.replace === 0) return undefined;
  if (counts.replace !== counts.total) return undefined;
  return "[info: this edit used replace (unverified). For safer future edits, prefer set_line/replace_lines with an anchor from read/grep/search.]";
}
export function buildEditOutput(input: BuildEditOutputInput): EditOutputResult {
  const summary = `Updated ${input.displayPath}`;
  const visibleSummary = `${buildVisibleSummary(input.displayPath, input.diff, input.edits)}${formatSemanticSuffix(input.semanticSummary)}`;
  const semanticWarning = formatWhitespaceOnlyWarning(input.semanticSummary, input.edits);
  const warningText = input.warnings.length ? `\n\nWarnings:\n${input.warnings.join("\n")}` : "";
  const replaceHint = formatReplaceHint(input.edits, input.noopEdits);
  let text = visibleSummary;
  if (semanticWarning) text += `\n${semanticWarning}`;
  text += warningText;
  if (replaceHint) text += `\n${replaceHint}`;
  return {
    text,
    patch: input.patch ?? "",
    readseekValue: buildReadseekEditResult({
      path: input.path,
      summary,
      diff: input.diff,
      ...(input.diffData ? { diffData: input.diffData } : {}),
      firstChangedLine: input.firstChangedLine,
      warnings: input.warnings,
      noopEdits: input.noopEdits,
      ...(input.semanticSummary ? { semanticSummary: input.semanticSummary } : {}),
    }),
  };
}
