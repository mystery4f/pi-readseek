import { readFile as fsReadFile } from "node:fs/promises";

import { normalizeToLF, stripBom, hasBareCarriageReturn } from "./edit-diff.js";
import { escapeControlCharsForDisplay } from "./hashline.js";
import { buildReadSeekWarning, type ReadSeekLine, type ReadSeekWarning } from "./readseek-value.js";
import { looksLikeBinary } from "./binary-detect.js";
import { throwIfAborted } from "./runtime.js";
import { formatFsError } from "./fs-error.js";
import { coerceObviousBase10Int } from "./coerce-obvious-int.js";
import { readseekRead } from "./readseek-client.js";
import { getOrGenerateMap } from "./file-map.js";
import { findSymbol, type SymbolMatch } from "./readseek/symbol-lookup.js";

/**
 * Outcome of `readAnchoredRange`: either a text file with anchored lines, a
 * binary file (image/other — callers handle themselves), or an ambiguous
 * symbol lookup (callers render candidates).
 *
 * Errors (missing file, readseek failure, invalid params, etc.) are thrown with
 * a `{ code, message, path? }` shape so each tool can wrap into its own error
 * envelope.
 */
export type ReadRangeResult =
	| ReadRangeText
	| ReadRangeBinary
	| ReadRangeAmbiguous;

export interface ReadRangeText {
	kind: "text";
	absolutePath: string;
	lines: ReadSeekLine[];
	startLine: number;
	endLine: number;
	totalLines: number;
	warnings: ReadSeekWarning[];
	/** Available when a symbol was looked up (even if not found). */
	symbolFileMap: import("./readseek/types.js").FileMap | null;
	symbolMatch?: SymbolMatch;
	symbolQuery?: string;
	/** The full split payload — kept so callers (e.g. read's bundle) can slice extra context. */
	allLines: string[];
}

export interface ReadRangeBinary {
	kind: "binary";
	absolutePath: string;
	rawBuffer: Buffer;
}

export interface ReadRangeAmbiguous {
	kind: "ambiguous";
	message: string;
}

export interface ReadRangeInput {
	rawPath: string;
	cwd: string;
	offset?: number | string;
	limit?: number | string;
	symbol?: string;
	signal?: AbortSignal;
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const withoutTrailingTerminator = text.endsWith("\n") ? text.slice(0, -1) : text;
	return withoutTrailingTerminator.split("\n");
}

const offsetRegex = /^@/;

/**
 * Read a single file range, resolve optional `symbol`, and return
 * anchored lines through readseek. Every read-tier tool in this package
 * shares this pipeline; per-tool features (bundle, map, image attachments,
 * per-file truncation, OCR modes) stay in the individual callers.
 */
export async function readAnchoredRange(input: ReadRangeInput): Promise<ReadRangeResult> {
	const { rawPath, cwd, signal } = input;

	// --- path resolution ---
	const sanitized = rawPath.replace(offsetRegex, "");
	const absolutePath = await import("./path-utils.js").then((m) => m.resolveToCwd(sanitized, cwd));

	// --- offset / limit ---
	const offset = coerceObviousBase10Int(input.offset, "offset");
	if (!offset.ok) throw { code: "invalid-offset", message: offset.message, path: rawPath };
	const limit = coerceObviousBase10Int(input.limit, "limit");
	if (!limit.ok) throw { code: "invalid-limit", message: limit.message, path: rawPath };
	if (limit.value !== undefined && limit.value < 1) {
		throw { code: "invalid-limit", message: `Invalid limit: expected a positive integer, received ${limit.value}.`, path: rawPath };
	}
	if (offset.value !== undefined && offset.value < 1) {
		throw { code: "invalid-offset", message: `Invalid offset: expected a positive integer, received ${offset.value}.`, path: rawPath };
	}

	// --- symbol ---
	const trimmedSymbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
	if (trimmedSymbol && (offset.value !== undefined || limit.value !== undefined)) {
		throw { code: "invalid-params-combo", message: "Cannot combine symbol with offset/limit. Use one or the other.", path: rawPath };
	}

	throwIfAborted(signal);

	// --- read file ---
	let rawBuffer: Buffer;
	try {
		rawBuffer = await fsReadFile(absolutePath);
	} catch (err: any) {
		const { code, message } = formatFsError(err, "read-error");
		throw { code, message: `${code}: ${message.replace(/^read-error:\s*/, "")}`, path: rawPath };
	}

	// --- binary detection ---
	if (looksLikeBinary(rawBuffer)) {
		return { kind: "binary", absolutePath, rawBuffer };
	}

	throwIfAborted(signal);

	// --- normalize & split ---
	const rawText = rawBuffer.toString("utf-8");
	const normalized = normalizeToLF(stripBom(rawText).text);
	const allLines = splitLines(normalized);
	const total = allLines.length;

	// --- range ---
	let startLine = offset.value ?? 1;
	let endIdx = limit.value !== undefined ? Math.min(startLine - 1 + limit.value, total) : total;

	if (offset.value !== undefined && startLine > total) {
		throw { code: "offset-past-end", message: `offset ${offset.value} is past end of file (${total} lines)`, path: rawPath };
	}

	// --- symbol lookup ---
	const warnings: ReadSeekWarning[] = [];
	let symbolFileMap: import("./readseek/types.js").FileMap | null = null;
	let symbolMatch: SymbolMatch | undefined;
	let symbolQuery: string | undefined;

	if (trimmedSymbol) {
		const ext = sanitized.split(".").pop()?.toLowerCase() ?? "";
		symbolFileMap = await getOrGenerateMap(absolutePath);
		if (!symbolFileMap) {
			const extLabel = ext || "unknown";
			warnings.push(buildReadSeekWarning("symbol-unmappable", `[Warning: symbol lookup not available for .${extLabel} files — showing full file]`));
		} else {
			const lookup = findSymbol(symbolFileMap, trimmedSymbol);
			if (lookup.type === "ambiguous") {
				const { formatAmbiguous } = await import("./readseek/symbol-error-format.js");
				return { kind: "ambiguous", message: formatAmbiguous(trimmedSymbol, lookup.candidates) };
			}
			if (lookup.type === "not-found") {
				const { formatNotFound } = await import("./readseek/symbol-error-format.js");
				warnings.push(buildReadSeekWarning("symbol-not-found", formatNotFound(trimmedSymbol, symbolFileMap)));
			}
			if (lookup.type === "found") {
				startLine = Math.max(1, lookup.symbol.startLine);
				endIdx = Math.min(total, lookup.symbol.endLine);
				symbolMatch = lookup.symbol;
				symbolQuery = trimmedSymbol;
			}
			if (lookup.type === "fuzzy") {
				startLine = Math.max(1, lookup.symbol.startLine);
				endIdx = Math.min(total, lookup.symbol.endLine);
				symbolMatch = lookup.symbol;
				symbolQuery = trimmedSymbol;
				const tierLabel = lookup.tier === "camelCase" ? "camelCase word boundary" : "substring";
				const otherNames = lookup.otherCandidates.map((c) => `\`${c.name}\``).join(", ");
				const lines = [
					`[Symbol '${trimmedSymbol}' not exact-matched. Closest match: \`${lookup.symbol.name}\` (${lookup.symbol.kind}, lines ${lookup.symbol.startLine}-${lookup.symbol.endLine}) via ${tierLabel}.`,
				];
				if (otherNames) lines.push(` Other candidates: ${otherNames}.`);
				warnings.push(buildReadSeekWarning("fuzzy-symbol-match", lines.join("\n"), {
					tier: lookup.tier,
					symbol: lookup.symbol,
					otherCandidates: lookup.otherCandidates,
				}));
			}
		}
	}

	// --- readseek anchored read ---
	let readseekOutput: Awaited<ReturnType<typeof readseekRead>>;
	try {
		readseekOutput = total === 0
			? await readseekRead(absolutePath)
			: await readseekRead(absolutePath, startLine, endIdx);
	} catch (err: any) {
		const detail = err?.message ? ` — ${err.message}` : "";
		throw { code: "readseek-error", message: `readseek failed while reading ${rawPath}${detail}`, path: rawPath };
	}

	// --- validate hashlines ---
	const expectedLineCount = Math.max(0, endIdx - startLine + 1);
	const invalidLine = readseekOutput.hashlines.find((line, i) => line.line !== startLine + i);
	if (readseekOutput.hashlines.length !== expectedLineCount || invalidLine) {
		const message = invalidLine
			? `readseek returned non-sequential line ${invalidLine.line} for requested range ${startLine}-${endIdx}`
			: `readseek returned ${readseekOutput.hashlines.length} lines for requested range ${startLine}-${endIdx} (${expectedLineCount} expected)`;
		throw { code: "readseek-output-mismatch", message, path: rawPath };
	}

	// --- build anchored lines ---
	const lines: ReadSeekLine[] = readseekOutput.hashlines.map((line) => ({
		line: line.line,
		hash: line.hash,
		anchor: `${line.line}:${line.hash}`,
		raw: line.text,
		display: escapeControlCharsForDisplay(line.text),
	}));

	if (hasBareCarriageReturn(rawText)) {
		warnings.push(buildReadSeekWarning("bare-cr", "[Warning: file contains bare CR (\\r) line endings — line numbering may be inconsistent with grep and other tools]"));
	}

	return {
		kind: "text",
		absolutePath,
		lines,
		startLine,
		endLine: endIdx,
		totalLines: total,
		warnings,
		symbolFileMap,
		symbolMatch,
		symbolQuery,
		allLines,
	};
}