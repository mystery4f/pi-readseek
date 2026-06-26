import { readseekMapContent } from "./readseek-client.js";
import { findSymbol } from "./readseek/symbol-lookup.js";
import { formatAmbiguous, formatNotFound } from "./readseek/symbol-error-format.js";
import { normalizeToLF } from "./edit-diff.js";

export interface ReplaceSymbolInput {
	filePath: string;
	content: string;
	symbol: string;
	newBody: string;
}

export type ReplaceSymbolResult =
	| { type: "ok"; content: string; replacement: string; warnings: string[]; range: { start: number; end: number } }
	| { type: "not-found"; message: string }
	| { type: "ambiguous"; message: string }
	| { type: "unsupported"; message: string };

function detectIndent(line: string): string {
	return line.match(/^\s*/)?.[0] ?? "";
}

function dedent(text: string): string {
	const lines = text.split("\n");
	const nonEmpty = lines.filter((l) => l.trim().length);
	if (!nonEmpty.length) return text;
	const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^\s*/)?.[0].length ?? 0));
	return lines.map((l) => l.slice(minIndent)).join("\n");
}

function reindent(text: string, indent: string): string {
	return text.split("\n").map((l) => (l.length ? indent + l : l)).join("\n");
}

export async function replaceSymbol(input: ReplaceSymbolInput): Promise<ReplaceSymbolResult> {
	const map = await readseekMapContent(input.filePath, input.content);
	if (!map) {
		return {
			type: "unsupported",
			message: `Unsupported file for replace_symbol: readseek could not map '${input.filePath}'. Use anchored edits for this file type.`,
		};
	}
	const lookup = findSymbol(map, input.symbol);
	if (lookup.type === "not-found") {
		return { type: "not-found", message: formatNotFound(input.symbol, map) };
	}
	if (lookup.type === "ambiguous") {
		return { type: "ambiguous", message: formatAmbiguous(input.symbol, lookup.candidates) };
	}
	const sym = lookup.symbol;
	const lines = input.content.split("\n");
	const sigLine = lines[sym.startLine - 1] ?? "";
	const indent = detectIndent(sigLine);
	const reindented = reindent(dedent(normalizeToLF(input.newBody)), indent);
	const warnings: string[] = [];
	const leaf = input.symbol.replace(/@\d+$/, "").split(".").pop() ?? "";
	const declNameRe =
		/\b(?:(?:export\s+(?:default\s+)?|async\s+|public\s+|private\s+|protected\s+|static\s+)*)(?:function\*?|class|const|let|var|fn|def|method|type|interface|enum)\s+([A-Za-z_$][\w$]*)/s;
	const firstDeclName =
		reindented.match(declNameRe)?.[1]
		?? reindented.match(/^\s*(?:(?:async\s+)?[\w$<>,?\s]+\s+)?([A-Za-z_$][\w$]*)\s*\(/)?.[1];
	if (leaf && firstDeclName && firstDeclName !== leaf) {
		warnings.push(`name-mismatch: expected ${leaf}, got ${firstDeclName}`);
	}
	const before = lines.slice(0, sym.startLine - 1).join("\n");
	const after = lines.slice(sym.endLine).join("\n");
	const beforePart = before.length ? before + "\n" : "";
	const afterPart = after.length ? "\n" + after : "";
	const newContent = beforePart + reindented + afterPart;
	return {
		type: "ok",
		content: newContent,
		replacement: reindented,
		warnings,
		range: { start: sym.startLine, end: sym.endLine },
	};
}
