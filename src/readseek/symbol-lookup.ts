import type { FileMap, FileSymbol } from "./types.js";
import type { SymbolKind } from "./enums.js";
import { traverseSymbolTree } from "./symbol-tree.js";

export interface SymbolMatch {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  parentName?: string;
}

type SymbolLookupResult =
  | { type: "found"; symbol: SymbolMatch }
  | { type: "ambiguous"; candidates: SymbolMatch[] }
  | {
      type: "fuzzy";
      symbol: SymbolMatch;
      tier: "camelCase" | "substring";
      otherCandidates: SymbolMatch[];
    }
  | { type: "not-found"; message?: string; candidates?: SymbolMatch[] };

function toMatch(symbol: FileSymbol, parentName?: string): SymbolMatch {
  return {
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    ...(parentName ? { parentName } : {}),
  };
}

interface SymbolCandidate {
  symbol: FileSymbol;
  parentName?: string;
}

function toMatches(candidates: SymbolCandidate[]): SymbolMatch[] {
  return candidates.map((candidate) => toMatch(candidate.symbol, candidate.parentName));
}

function flattenSymbols(symbols: FileSymbol[]): SymbolCandidate[] {
  return traverseSymbolTree(symbols, (symbol, parentName) => ({ symbol, parentName }));
}

function resolveDotPath(symbols: FileSymbol[], parts: string[]): SymbolCandidate[] {
  let candidates: SymbolCandidate[] = symbols
    .filter((symbol) => symbol.name === parts[0])
    .map((symbol) => ({ symbol }));

  for (let i = 1; i < parts.length; i++) {
    const nextCandidates: SymbolCandidate[] = [];

    for (const candidate of candidates) {
      for (const child of candidate.symbol.children ?? []) {
        if (child.name === parts[i]) {
          nextCandidates.push({ symbol: child, parentName: candidate.symbol.name });
        }
      }
    }

    candidates = nextCandidates;
  }

  return candidates;
}

const JAVA_TOP_LEVEL_TYPE_KINDS = new Set(["class", "interface", "enum", "module"]);

function preferJavaTopLevelType(map: FileMap, candidates: SymbolCandidate[]): SymbolCandidate | undefined {
  if (map.language !== "Java") return undefined;
  const topLevelTypes = candidates.filter(
    (candidate) => !candidate.parentName && JAVA_TOP_LEVEL_TYPE_KINDS.has(candidate.symbol.kind),
  );
  return topLevelTypes.length === 1 ? topLevelTypes[0] : undefined;
}

function resolveDotPathSuffix(symbols: FileSymbol[], parts: string[]): SymbolCandidate[] {
  for (let start = 1; start < parts.length; start++) {
    const candidates = resolveDotPath(symbols, parts.slice(start));
    if (candidates.length > 0) return candidates;
  }
  return [];
}

export function findSymbol(map: FileMap, query: string): SymbolLookupResult {
  const q = query.trim();
  if (!q) return { type: "not-found" };
  if (map.symbols.length === 0) return { type: "not-found" };

  const allSymbols = flattenSymbols(map.symbols);

  const atLineMatch = /^(.+?)@(\d+)$/.exec(q);
  if (atLineMatch) {
    const namePart = atLineMatch[1];
    const lineNum = Number.parseInt(atLineMatch[2], 10);
    let pool: SymbolCandidate[];
    if (namePart.includes(".")) {
      const parts = namePart.split(".").map((p) => p.trim());
      pool = parts.every((p) => p.length > 0)
        ? resolveDotPath(map.symbols, parts)
        : [];
      if (pool.length === 0) {
        pool = allSymbols.filter((c) => c.symbol.name === namePart);
      }
    } else {
      pool = allSymbols.filter((c) => c.symbol.name === namePart);
    }
    // drop candidates without usable startLine. If that empties
    // the pool entirely, surface any same-leaf-name decls elsewhere in the file
    // so the user can see real candidate lines.
    pool = pool.filter((c) => Number.isFinite(c.symbol.startLine) && c.symbol.startLine > 0);
    if (pool.length === 0) {
      const leaf = namePart.split(".").pop() ?? namePart;
      const sameLeaf = allSymbols.filter(
        (c) => c.symbol.name === leaf
          && Number.isFinite(c.symbol.startLine)
          && c.symbol.startLine > 0,
      );
      if (sameLeaf.length > 0) {
        const list = sameLeaf
          .slice(0, 5)
          .map((c) => `${c.parentName ? c.parentName + "." : ""}${c.symbol.name}@${c.symbol.startLine}`)
          .join(", ");
        return {
          type: "not-found",
          message: `${q} not found. Candidates: ${list}`,
          candidates: toMatches(sameLeaf.slice(0, 5)),
        };
      }
    }
    if (pool.length > 0) {
      const containing = pool.filter(
        (c) => c.symbol.startLine <= lineNum && c.symbol.endLine >= lineNum,
      );
      if (containing.length > 0) {
        return { type: "found", symbol: toMatch(containing[0].symbol, containing[0].parentName) };
      }
      const below = pool
        .filter((c) => c.symbol.startLine >= lineNum)
        .sort((a, b) => a.symbol.startLine - b.symbol.startLine);
      if (below.length) {
        return { type: "found", symbol: toMatch(below[0].symbol, below[0].parentName) };
      }
      const above = pool
        .filter((c) => c.symbol.startLine < lineNum)
        .sort((a, b) => b.symbol.startLine - a.symbol.startLine);
      if (above.length) {
        return { type: "found", symbol: toMatch(above[0].symbol, above[0].parentName) };
      }
    }
  }

  const exact = allSymbols.filter((c) => c.symbol.name === q);
  if (exact.length === 1) return { type: "found", symbol: toMatch(exact[0].symbol, exact[0].parentName) };
  if (exact.length > 1) {
    const preferred = preferJavaTopLevelType(map, exact);
    if (preferred) return { type: "found", symbol: toMatch(preferred.symbol, preferred.parentName) };
    return { type: "ambiguous", candidates: toMatches(exact.slice(0, 5)) };
  }

  if (q.includes(".")) {
    const parts = q.split(".").map((p) => p.trim());
    if (parts.length >= 2 && parts.every((p) => p.length > 0)) {
      const candidates = resolveDotPath(map.symbols, parts);
      if (candidates.length === 1) {
        return { type: "found", symbol: toMatch(candidates[0].symbol, candidates[0].parentName) };
      }
      if (candidates.length > 1) {
        return {
          type: "ambiguous",
          candidates: toMatches(candidates.slice(0, 5)),
        };
      }
      const suffixCandidates = resolveDotPathSuffix(map.symbols, parts);
      if (suffixCandidates.length === 1) {
        return { type: "found", symbol: toMatch(suffixCandidates[0].symbol, suffixCandidates[0].parentName) };
      }
      if (suffixCandidates.length > 1) {
        return {
          type: "ambiguous",
          candidates: toMatches(suffixCandidates.slice(0, 5)),
        };
      }
    }
  }

  const qLower = q.toLowerCase();

  // Tier 1: case-insensitive exact
  const ci = allSymbols.filter((c) => c.symbol.name.toLowerCase() === qLower);
  if (ci.length === 1) return { type: "found", symbol: toMatch(ci[0].symbol, ci[0].parentName) };
  if (ci.length > 1) return { type: "ambiguous", candidates: toMatches(ci.slice(0, 5)) };

  // Tier 2: prefix match
  const prefix = allSymbols.filter((c) => c.symbol.name.toLowerCase().startsWith(qLower));
  if (prefix.length === 1) return { type: "found", symbol: toMatch(prefix[0].symbol, prefix[0].parentName) };
  if (prefix.length > 1) return { type: "ambiguous", candidates: toMatches(prefix.slice(0, 5)) };

  // Tier 3: camelCase word boundary match
  const camelCase = allSymbols.filter((c) => {
    const words = c.symbol.name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_]+/);
    return words.some((w) => w === qLower);
  });

  // Tier 4: substring match
  const partial = allSymbols.filter((c) => c.symbol.name.toLowerCase().includes(qLower));
  const buildOtherCandidates = (chosen: SymbolCandidate): SymbolMatch[] => {
    const pool: SymbolCandidate[] = [];
    const seen = new Set<FileSymbol>();
    seen.add(chosen.symbol);
    for (const c of [...camelCase, ...partial]) {
      if (seen.has(c.symbol)) continue;
      seen.add(c.symbol);
      pool.push(c);
    }
    return toMatches(pool.slice(0, 4));
  };
  if (camelCase.length === 1) {
    return {
      type: "fuzzy",
      symbol: toMatch(camelCase[0].symbol, camelCase[0].parentName),
      tier: "camelCase",
      otherCandidates: buildOtherCandidates(camelCase[0]),
    };
  }
  if (camelCase.length > 1) return { type: "ambiguous", candidates: toMatches(camelCase.slice(0, 5)) };
  if (partial.length === 1) {
    return {
      type: "fuzzy",
      symbol: toMatch(partial[0].symbol, partial[0].parentName),
      tier: "substring",
      otherCandidates: buildOtherCandidates(partial[0]),
    };
  }
  if (partial.length > 1) return { type: "ambiguous", candidates: toMatches(partial.slice(0, 5)) };

  return { type: "not-found" };
}
