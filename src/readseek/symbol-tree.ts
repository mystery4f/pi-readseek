import type { FileSymbol } from "./types.js";

/**
 * Depth-first walk over a readseek symbol tree. {@link visit} is called for
 * every symbol with the enclosing symbol's name as `parentName` (undefined at
 * the top level); its results are returned flattened in pre-order.
 */
export function traverseSymbolTree<T>(
  symbols: FileSymbol[],
  visit: (symbol: FileSymbol, parentName?: string) => T,
): T[] {
  const result: T[] = [];
  const walk = (nodes: FileSymbol[], parentName?: string) => {
    for (const symbol of nodes) {
      result.push(visit(symbol, parentName));
      if (symbol.children?.length) walk(symbol.children, symbol.name);
    }
  };
  walk(symbols);
  return result;
}
