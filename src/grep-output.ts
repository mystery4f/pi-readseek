import type { ReadSeekLine, ReadSeekWarning } from "./readseek-value.js";
import {
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { resolveGrepOutputBudget } from "./grep-budget.js";

export interface GrepOutputRecord extends ReadSeekLine {
  path: string;
  kind: "match" | "context";
}

interface GrepOutputReadSeekRecord {
  path: string;
  line: number;
  anchor: string;
  kind: "match" | "context";
}

export type GrepOutputEntry =
  | { kind: "match" | "context"; line: ReadSeekLine }
  | { kind: "separator"; text: string };

export interface GrepOutputScopeSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  parentName?: string;
}

export interface GrepScopeWarning extends ReadSeekWarning {
  path?: string;
  line?: number;
}

export interface GrepOutputGroup {
  displayPath: string;
  absolutePath: string;
  matchCount: number;
  entries: GrepOutputEntry[];
  scope?: {
    mode: "symbol";
    symbol: GrepOutputScopeSymbol;
    matchLines: number[];
    contextLines?: number;
  };
}

type ScopedGrepOutputGroup = GrepOutputGroup & {
  scope: NonNullable<GrepOutputGroup["scope"]>;
};

function hasScope(group: GrepOutputGroup): group is ScopedGrepOutputGroup {
  return group.scope !== undefined;
}

interface BuildGrepOutputInput {
  summary: boolean;
  totalMatches: number;
  groups: GrepOutputGroup[];
  limit?: number;
  records: GrepOutputRecord[];
  scopeMode?: "symbol";
  scopeWarnings?: GrepScopeWarning[];
  passthroughLines?: string[];
}

interface GrepOutputResult {
  text: string;
  readseekValue: {
    tool: "grep";
    summary: boolean;
    totalMatches: number;
    records: GrepOutputReadSeekRecord[];
    scopes?: {
      mode: "symbol";
      groups: Array<{
        path: string;
        displayPath: string;
        symbol: GrepOutputScopeSymbol;
        matchCount: number;
        matchLines: number[];
        lineAnchors: string[];
      }>;
      warnings: GrepScopeWarning[];
    };
  };
}

function renderEntry(displayPath: string, entry: GrepOutputEntry): string {
  if (entry.kind === "separator") return entry.text;
  const marker = entry.kind === "match" ? ">>" : "  ";
  return `${displayPath}:${marker}${entry.line.anchor}|${entry.line.display}`;
}

function renderGroupHeader(group: GrepOutputGroup): string {
  if (!group.scope) {
    return `--- ${group.displayPath} (${group.matchCount} matches) ---`;
  }

  const parent = group.scope.symbol.parentName ? ` in ${group.scope.symbol.parentName}` : "";
  const suffix = group.scope.contextLines !== undefined ? `, scoped to ±${group.scope.contextLines} lines` : "";
  return `--- ${group.displayPath} :: ${group.scope.symbol.kind} ${group.scope.symbol.name}${parent} (${group.scope.symbol.startLine}-${group.scope.symbol.endLine}, ${group.matchCount} matches${suffix}) ---`;
}

function buildScopeMetadata(groups: GrepOutputGroup[], warnings: GrepScopeWarning[]) {
  return {
    mode: "symbol" as const,
    groups: groups
      .filter(hasScope)
      .map((group) => ({
        path: group.absolutePath,
        displayPath: group.displayPath,
        symbol: group.scope.symbol,
        matchCount: group.matchCount,
        matchLines: [...group.scope.matchLines],
        lineAnchors: group.entries.flatMap((entry) => (entry.kind === "separator" ? [] : [entry.line.anchor])),
      })),
    warnings: [...warnings],
  };
}

export function buildGrepOutput(input: BuildGrepOutputInput): GrepOutputResult {
  const fileCount = new Set(input.groups.map((group) => group.absolutePath)).size;
  const header = `[${input.totalMatches} matches in ${fileCount} files]`;
  let text: string;
  if (input.summary) {
    const fileLines = [...input.groups]
      .sort((a, b) => b.matchCount - a.matchCount)
      .map((group) => `${group.absolutePath}: ${group.matchCount} matches`);
    text = [header, ...fileLines].join("\n");
  } else {
    const blocks: string[] = [header];
    for (const group of input.groups) {
      blocks.push(renderGroupHeader(group));
      for (const entry of group.entries) {
        blocks.push(renderEntry(group.displayPath, entry));
      }
    }
    text = blocks.join("\n");
  }
  const passthroughLines = input.passthroughLines ?? [];
  if (passthroughLines.length > 0) {
    text += `\n\n${passthroughLines.join("\n")}`;
  }
  if (input.limit !== undefined && input.totalMatches === input.limit) {
    text += `\n\n[Results truncated at ${input.limit} matches — refine pattern or increase limit]`;
  }
  const scopeWarnings = input.scopeWarnings ?? [];
  if (!input.summary && input.scopeMode === "symbol" && scopeWarnings.length > 0) {
    text = `${scopeWarnings.map((warning) => warning.message).join("\n\n")}\n\n${text}`;
  }
  const budget = resolveGrepOutputBudget();
  const truncated = truncateHead(text, {
    maxLines: budget.maxLines,
    maxBytes: budget.maxBytes,
  });
  if (truncated.truncated) {
    text = `${truncated.content}\n\n[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Refine pattern or increase limit.]`;
  }
  const readseekValue: GrepOutputResult["readseekValue"] = {
    tool: "grep",
    summary: input.summary,
    totalMatches: input.totalMatches,
    records: input.records.map((record) => ({
      path: record.path,
      line: record.line,
      anchor: record.anchor,
      kind: record.kind,
    })),
  };
  if (!input.summary && input.scopeMode === "symbol") {
    readseekValue.scopes = buildScopeMetadata(input.groups, scopeWarnings);
  }

  return {
    text,
    readseekValue,
  };
}
