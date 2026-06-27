import { SymbolKind } from "./readseek/enums.js";
import type { SymbolMatch } from "./readseek/symbol-lookup.js";
import type { FileMap, FileSymbol } from "./readseek/types.js";
import { traverseSymbolTree } from "./readseek/symbol-tree.js";

export interface LocalBundleSupport {
  symbol: SymbolMatch;
  lines: string[];
}

export interface LocalBundlePlan {
  requested: SymbolMatch;
  support: LocalBundleSupport[];
}

interface FlatSymbol {
  symbol: FileSymbol;
  parentName?: string;
}

const CONTAINER_KINDS = new Set<SymbolKind>([
  SymbolKind.Class,
  SymbolKind.Module,
  SymbolKind.Namespace,
]);

export function buildLocalBundle(
  fileMap: FileMap,
  requested: SymbolMatch,
  allLines: string[],
): LocalBundlePlan | null {
  const requestedText = allLines.slice(requested.startLine - 1, requested.endLine).join("\n");
  const identifiers = new Set(requestedText.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []);

  const candidates = traverseSymbolTree(fileMap.symbols, (symbol, parentName): FlatSymbol => ({ symbol, parentName })).filter(({ symbol }) => {
    if (CONTAINER_KINDS.has(symbol.kind as SymbolKind)) return false;
    return !(symbol.name === requested.name && symbol.startLine === requested.startLine && symbol.endLine === requested.endLine);
  });

  const symbolsByName = new Map<string, FlatSymbol[]>();
  for (const candidate of candidates) {
    const bucket = symbolsByName.get(candidate.symbol.name) ?? [];
    bucket.push(candidate);
    symbolsByName.set(candidate.symbol.name, bucket);
  }

  const support: LocalBundleSupport[] = [];
  for (const identifier of identifiers) {
    const matches = symbolsByName.get(identifier) ?? [];
    if (matches.length === 0) continue;
    if (matches.length > 1) return null;

    const match = matches[0];
    support.push({
      symbol: {
        name: match.symbol.name,
        kind: match.symbol.kind,
        startLine: match.symbol.startLine,
        endLine: match.symbol.endLine,
        ...(match.parentName ? { parentName: match.parentName } : {}),
      },
      lines: allLines.slice(match.symbol.startLine - 1, match.symbol.endLine),
    });
  }

  support.sort((a, b) => {
    if (a.symbol.startLine !== b.symbol.startLine) return a.symbol.startLine - b.symbol.startLine;
    return a.symbol.name.localeCompare(b.symbol.name);
  });

  return {
    requested,
    support,
  };
}
