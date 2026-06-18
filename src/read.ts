import type { ExtensionAPI, ToolRenderResultOptions, AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	createReadTool,
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { defineToolPromptMetadata } from "./tool-prompt-metadata.js";
import { readFile as fsReadFile } from "fs/promises";
import { normalizeToLF, stripBom, hasBareCarriageReturn } from "./edit-diff.js";
import { ensureHashInit, escapeControlCharsForDisplay } from "./hashline.js";
import { buildReadseekWarning, buildToolErrorResult, renderReadseekLines, type ReadseekLine, type ReadseekWarning } from "./readseek-value.js";
import { looksLikeBinary } from "./binary-detect.js";
import { isSupportedImageBuffer } from "./image-detect.js";
import { resolveToCwd } from "./path-utils.js";
import { throwIfAborted } from "./runtime.js";
import { getOrGenerateMap } from "./map-cache.js";
import { formatFileMapWithBudget } from "./readseek/formatter.js";
import { findSymbol, type SymbolMatch } from "./readseek/symbol-lookup.js";
import { formatAmbiguous, formatNotFound } from "./readseek/symbol-error-format.js";
import { buildReadOutput } from "./read-output.js";

import { buildLocalBundle } from "./read-local-bundle.js";
import { coerceObviousBase10Int } from "./coerce-obvious-int.js";
import { readseekRead } from "./readseek-client.js";
import { Text } from "@earendil-works/pi-tui";
import { formatReadCallText, formatReadResultText } from "./read-render-helpers.js";
import { clampLineToWidth, clampLinesToWidth, linkToolPath, renderToolLabel, resolveRenderResultContext, summaryLine, wrapReadHashlinesForWidth } from "./tui-render-utils.js";
import type { FileAnchoredCallback } from "./tool-types.js";

const READ_PROMPT_METADATA = defineToolPromptMetadata({
	promptUrl: new URL("../prompts/read.md", import.meta.url),
	promptSnippet: "Read text files or images; text reads include hashline anchors and optional maps/symbol lookup",
});

interface ReadParams {
	path: string;
	offset?: number | string;
	limit?: number | string;
	symbol?: string;
	map?: boolean;
	bundle?: "local";
}

interface ReadToolOptions {
	onSuccessfulRead?: FileAnchoredCallback;
}

export interface ExecuteReadOptions {
	toolCallId: string;
	params: unknown;
	signal: AbortSignal | undefined;
	onUpdate: any;
	cwd: string;
	onSuccessfulRead?: FileAnchoredCallback;
}

export async function executeRead(opts: ExecuteReadOptions): Promise<AgentToolResult<any>> {
	const { toolCallId, params, signal, onUpdate, cwd, onSuccessfulRead } = opts;
	await ensureHashInit();
	const rawParams = params as ReadParams;
	const offset = coerceObviousBase10Int(rawParams.offset, "offset");
	if (!offset.ok) {
		return buildToolErrorResult("read", "invalid-offset", offset.message, { path: rawParams.path });
	}
	const limit = coerceObviousBase10Int(rawParams.limit, "limit");
	if (!limit.ok) {
		return buildToolErrorResult("read", "invalid-limit", limit.message, { path: rawParams.path });
	}
	if (limit.value !== undefined && limit.value < 1) {
		const message = `Invalid limit: expected a positive integer, received ${limit.value}.`;
		return buildToolErrorResult("read", "invalid-limit", message, { path: rawParams.path });
	}
	if (offset.value !== undefined && offset.value < 1) {
		const message = `Invalid offset: expected a positive integer, received ${offset.value}.`;
		return buildToolErrorResult("read", "invalid-offset", message, { path: rawParams.path });
	}
	const p = {
		...rawParams,
		offset: offset.value,
		limit: limit.value,
	};
	if (rawParams.symbol !== undefined) {
		const trimmedSymbol = typeof rawParams.symbol === "string" ? rawParams.symbol.trim() : "";
		if (trimmedSymbol.length === 0) {
			const message = "Invalid symbol: expected a non-empty string.";
			return buildToolErrorResult("read", "invalid-params-combo", message, { path: rawParams.path });
		}
		p.symbol = trimmedSymbol;
	}
	const rawPath = p.path.replace(/^@/, "");
	const absolutePath = resolveToCwd(rawPath, cwd);
	const succeed = <T extends AgentToolResult<any>>(result: T): T => {
		const isError = (result as { isError?: boolean }).isError;
		if (!isError) {
			onSuccessfulRead?.(absolutePath);
		}
		return result;
	};

	throwIfAborted(signal);
	if (p.symbol && (p.offset !== undefined || p.limit !== undefined)) {
		const message = "Cannot combine symbol with offset/limit. Use one or the other.";
		return buildToolErrorResult("read", "invalid-params-combo", message, { path: rawParams.path });
	}
	if (p.bundle && !p.symbol) {
		const message = 'Cannot use bundle without symbol. Use read({ path, symbol, bundle: "local" }).';
		return buildToolErrorResult("read", "invalid-params-combo", message, { path: rawParams.path });
	}
	if (p.bundle && p.map) {
		const message = "Cannot combine bundle with map. Use one or the other.";
		return buildToolErrorResult("read", "invalid-params-combo", message, { path: rawParams.path });
	}
	if (p.map && p.symbol) {
		const message = "Cannot combine map with symbol. Use one or the other.";
		return buildToolErrorResult("read", "invalid-params-combo", message, { path: rawParams.path });
	}
	// Delegate images to the built-in read tool
	throwIfAborted(signal);
	const ext = rawPath.split(".").pop()?.toLowerCase() ?? "";
	if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
		const builtinRead = createReadTool(cwd);
		return succeed(await builtinRead.execute(toolCallId, p, signal, onUpdate));
	}

	throwIfAborted(signal);
	let rawBuffer: Buffer;
	try {
		rawBuffer = await fsReadFile(absolutePath);
	} catch (err: any) {
		const code = err?.code;
		if (code === "EISDIR") {
			const message = `Path is a directory: ${rawPath}. Use ls to inspect directories.`;
			return buildToolErrorResult("read", "path-is-directory", message, { path: rawParams.path, hint: `Use ls(${JSON.stringify(rawPath)}) to inspect directories.` });
		}
		if (code === "EACCES" || code === "EPERM") {
			const message = `Permission denied — cannot access: ${rawPath}`;
			return buildToolErrorResult("read", "permission-denied", message, { path: rawParams.path });
		}
		if (code === "ENOENT") {
			const message = `File not found: ${rawPath}`;
			return buildToolErrorResult("read", "file-not-found", message, { path: rawParams.path });
		}
		const message = `File not readable: ${rawPath}${err?.message ? ` — ${err.message}` : ""}`;
		return buildToolErrorResult("read", "fs-error", message, { path: rawParams.path, details: { fsCode: code, fsMessage: err?.message } });
	}

	if (isSupportedImageBuffer(rawBuffer)) {
		const builtinRead = createReadTool(cwd);
		return succeed(await builtinRead.execute(toolCallId, p, signal, onUpdate));
	}
	const hasBinaryContent = looksLikeBinary(rawBuffer);
	throwIfAborted(signal);
	const normalized = normalizeToLF(stripBom(rawBuffer.toString("utf-8")).text);
	const allLines = splitReadseekLines(normalized);
	const total = allLines.length;
	const structuredWarnings: ReadseekWarning[] = [];
	let startLine = p.offset !== undefined ? p.offset : 1;
	let endIdx = p.limit !== undefined ? Math.min(startLine - 1 + p.limit, total) : total;
	if (p.offset !== undefined && startLine > total) {
		const message = `[offset ${p.offset} is past end of file (${total} lines)]`;
		return buildToolErrorResult("read", "offset-past-end", message, { path: rawParams.path });
	}
	let symbolMatch: SymbolMatch | undefined;
	let symbolFileMap: Awaited<ReturnType<typeof getOrGenerateMap>> | null = null;
	let symbolWarning: string | undefined;
	let bundleMetadata:
		| {
				mode: "local";
				applied: boolean;
				localSupport: Array<{
					symbol: {
						query: string;
						name: string;
						kind: string;
						parentName?: string;
						startLine: number;
						endLine: number;
					};
					lines: string[];
				}>;
				warnings: ReadseekWarning[];
		  }
		| null = null;
	if (p.symbol) {
		symbolFileMap = await getOrGenerateMap(absolutePath);
		if (!symbolFileMap) {
			const extLabel = ext || "unknown";
			symbolWarning = `[Warning: symbol lookup not available for .${extLabel} files — showing full file]\n\n`;
		} else {
			const lookup = findSymbol(symbolFileMap, p.symbol);
			if (lookup.type === "ambiguous") {
				return succeed({
					content: [
						{
							type: "text",
							text: formatAmbiguous(p.symbol, lookup.candidates),
						},
					],
					isError: false,
					details: {},
				});
			}
			if (lookup.type === "not-found") {
				symbolWarning = `${formatNotFound(p.symbol, symbolFileMap)}\n\n`;
			}
			if (lookup.type === "found") {
				startLine = Math.max(1, lookup.symbol.startLine);
				endIdx = Math.min(total, lookup.symbol.endLine);
				symbolMatch = lookup.symbol;
			}
			if (lookup.type === "fuzzy") {
				startLine = Math.max(1, lookup.symbol.startLine);
				endIdx = Math.min(total, lookup.symbol.endLine);
				symbolMatch = lookup.symbol;

				const tierLabel = lookup.tier === "camelCase" ? "camelCase word boundary" : "substring";
				const otherNames = lookup.otherCandidates.map((c) => `\`${c.name}\``).join(", ");
				const confirmHint = `read({ symbol: "${lookup.symbol.name}" }) or ${lookup.symbol.name}@${lookup.symbol.startLine} to select by start line`;
				const lines = [
					`[Symbol '${p.symbol}' not exact-matched. Closest match: \`${lookup.symbol.name}\` (${lookup.symbol.kind}, lines ${lookup.symbol.startLine}-${lookup.symbol.endLine}) via ${tierLabel}.`,
				];
				if (otherNames) lines.push(` Other candidates: ${otherNames}.`);
				lines.push(` To confirm: ${confirmHint}.]`);
				const bannerText = lines.join("\n");
				structuredWarnings.push(
					buildReadseekWarning("fuzzy-symbol-match", bannerText, {
						tier: lookup.tier,
						symbol: lookup.symbol,
						otherCandidates: lookup.otherCandidates,
					}),
				);
			}
		}
	}

	if (p.bundle === "local") {
		if (!symbolFileMap) {
			const extLabel = ext || "unknown";
			const warning = buildReadseekWarning(
				"bundle-unmappable",
				`[Warning: local bundle unavailable because symbol mapping is not available for .${extLabel} files — showing plain symbol read]`,
			);
			structuredWarnings.push(warning);
			bundleMetadata = {
				mode: "local",
				applied: false,
				localSupport: [],
				warnings: [warning],
			};
		} else if (!symbolMatch) {
			bundleMetadata = {
				mode: "local",
				applied: false,
				localSupport: [],
				warnings: [],
			};
		} else {
			const bundle = buildLocalBundle(symbolFileMap, symbolMatch, allLines);
			if (!bundle) {
				const warning = buildReadseekWarning(
					"bundle-context-unavailable",
					`[Warning: local bundle context could not be determined for symbol '${symbolMatch.name}' — showing plain symbol read]`,
				);
				structuredWarnings.push(warning);
				bundleMetadata = {
					mode: "local",
					applied: false,
					localSupport: [],
					warnings: [warning],
				};
			} else {
				bundleMetadata = {
					mode: "local",
					applied: true,
					localSupport: bundle.support.map((item) => ({
						symbol: {
							query: item.symbol.name,
							name: item.symbol.name,
							kind: item.symbol.kind,
							parentName: item.symbol.parentName,
							startLine: item.symbol.startLine,
							endLine: item.symbol.endLine,
						},
						lines: item.lines,
					})),
					warnings: [],
				};
			}
		}
	}

	throwIfAborted(signal);
	let readseekOutput: Awaited<ReturnType<typeof readseekRead>>;
	try {
		readseekOutput = total === 0
			? await readseekRead(absolutePath)
			: await readseekRead(absolutePath, startLine, endIdx);
	} catch (err: any) {
		const detail = err?.message ? ` — ${err.message}` : "";
		const message = `readseek failed while reading ${rawPath}${detail}`;
		return buildToolErrorResult("read", "readseek-error", message, { path: rawParams.path, hint: "Ensure @jarkkojs/readseek and its npm platform package are installed.", details: { message: err?.message } });
	}
	const expectedLineCount = Math.max(0, endIdx - startLine + 1);
	const invalidLine = readseekOutput.hashlines.find((line, index) => line.line !== startLine + index);
	if (readseekOutput.hashlines.length !== expectedLineCount || invalidLine) {
		const message = invalidLine
			? `readseek returned non-sequential line ${invalidLine.line} for requested range ${startLine}-${endIdx}`
			: `readseek returned ${readseekOutput.hashlines.length} lines for requested range ${startLine}-${endIdx} (${expectedLineCount} expected)`;
		return buildToolErrorResult("read", "readseek-output-mismatch", message, { path: rawParams.path });
	}
	const readseekLines: ReadseekLine[] = readseekOutput.hashlines.map((line) => ({
		line: line.line,
		hash: line.hash,
		anchor: `${line.line}:${line.hash}`,
		raw: line.text,
		display: escapeControlCharsForDisplay(line.text),
	}));
	const selected = readseekLines.map((line) => line.raw);
	const formatted = renderReadseekLines(readseekLines);

	const truncation = truncateHead(formatted, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

	// Append structural map: on-demand (p.map) or auto on truncated full-file reads
	const shouldAppendMap = !!p.map || (!!truncation.truncated && !p.offset && !p.limit && !symbolMatch);
	let appendedMap = false;
	let mapText: string | null = null;
	if (shouldAppendMap) {
		try {
			const fileMap = await getOrGenerateMap(absolutePath);
			if (fileMap) {
				const formattedMap = formatFileMapWithBudget(fileMap);
				mapText = formattedMap;
				appendedMap = true;
			}
		} catch {
			// Map formatting failed — still return hashlined content without map
		}
	}

	if (symbolWarning) {
		structuredWarnings.push(buildReadseekWarning("symbol-warning", symbolWarning.trim()));
	}

	if (hasBinaryContent) {
		const warning = "[Warning: file appears to be binary — output may be garbled]";
		structuredWarnings.push(buildReadseekWarning("binary-content", warning));
	}

	if (hasBareCarriageReturn(rawBuffer.toString("utf-8"))) {
		const warning = "[Warning: file contains bare CR (\\r) line endings — line numbering may be inconsistent with grep and other tools]";
		structuredWarnings.push(buildReadseekWarning("bare-cr", warning));
	}

	const readOutput = buildReadOutput({
		path: absolutePath,
		startLine,
		endLine: endIdx,
		totalLines: total,
		selectedLines: selected,
		lines: readseekLines,
		warnings: structuredWarnings,
		truncation: truncation.truncated
			? {
					outputLines: truncation.outputLines,
					totalLines: total,
					outputBytes: truncation.outputBytes,
					totalBytes: truncation.totalBytes,
				}
			: null,
		continuation: !truncation.truncated && endIdx < total ? { nextOffset: endIdx + 1 } : null,
		symbol: symbolMatch
			? {
					query: p.symbol ?? symbolMatch.name,
					name: symbolMatch.name,
					kind: symbolMatch.kind,
					parentName: symbolMatch.parentName,
					startLine: symbolMatch.startLine,
					endLine: symbolMatch.endLine,
				}
			: null,
		map: {
			requested: !!p.map,
			appended: appendedMap,
			text: mapText,
		},
		...(bundleMetadata ? { bundle: bundleMetadata } : {}),
	});

	return succeed({
		content: [{ type: "text", text: readOutput.text }],
		details: {
			truncation: truncation.truncated ? truncation : undefined,
			readseekValue: readOutput.readseekValue,
		},
	});
}

function splitReadseekLines(text: string): string[] {
	if (text.length === 0) return [];
	const withoutTrailingTerminator = text.endsWith("\n") ? text.slice(0, -1) : text;
	return withoutTrailingTerminator.split("\n");
}

export function registerReadTool(pi: ExtensionAPI, options: ReadToolOptions = {}) {
	const toolConfig = {
		callable: true,
		enabled: true,
		policy: "read-only" as const,
		readOnly: true,
		pythonName: "read",
		defaultExposure: "safe-by-default" as const,
	};

	const tool = {
		name: "read",
		label: "Read",
		description: READ_PROMPT_METADATA.description,
		promptSnippet: READ_PROMPT_METADATA.promptSnippet,
		promptGuidelines: READ_PROMPT_METADATA.promptGuidelines,
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			offset: Type.Optional(
				Type.Union([
					Type.Number({ description: "Start line (1-indexed)" }),
					Type.String({ description: "Start line (1-indexed)" }),
				]),
			),
			limit: Type.Optional(
				Type.Union([
					Type.Number({ description: "Max lines" }),
					Type.String({ description: "Max lines" }),
				]),
			),
			symbol: Type.Optional(Type.String({ description: "Symbol name to read" })),
			map: Type.Optional(Type.Boolean({ description: "Append structural map" })),
			bundle: Type.Optional(
				Type.Literal("local", {
					description: "Include same-file local support",
				}),
			),
		}),
		ptc: toolConfig,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return executeRead({
				toolCallId,
				params,
				signal,
				onUpdate,
				cwd: ctx.cwd,
				onSuccessfulRead: options.onSuccessfulRead,
			});
		},
		renderCall(args: any, theme: any, ...rest: any[]) {
			const context = rest[0] ?? {};
			const cwd = context.cwd ?? process.cwd();
			const { path: filePath, suffix } = formatReadCallText(args);
			const rangeSuffix = typeof args?.offset === "number" && typeof args?.limit === "number" && args.offset > 0 && args.limit > 0
				? `:${args.offset}-${args.offset + args.limit - 1}`
				: "";
			let text = renderToolLabel(theme, "read");
			if (filePath) {
				text += ` ${linkToolPath(theme.fg("accent", `${filePath}${rangeSuffix}`), filePath, cwd)}`;
			} else {
				text += ` ${theme.fg("toolOutput", "...")}`;
			}
			if (!rangeSuffix && suffix) text += ` ${theme.fg("dim", suffix)}`;
			return new Text(clampLineToWidth(text, context.width), 0, 0);
		},
		renderResult(result: any, options: ToolRenderResultOptions, theme: any, ...rest: any[]) {
			const { isPartial, isError, expanded, width } = resolveRenderResultContext(options, rest);
			if (isPartial) return new Text(clampLinesToWidth([summaryLine("pending read")], width).join("\n"), 0, 0);

			const content = result.content?.[0];
			const textContent = content?.type === "text" ? content.text : "";
			if (isError || result.isError) {
				const firstLine = textContent.split("\n")[0] || "Error";
				const errorText = expanded ? (textContent || firstLine) : firstLine;
				return new Text(clampLinesToWidth([summaryLine(errorText)], width).join("\n"), 0, 0);
			}

			const readseekValue = (result.details as any)?.readseekValue as { range: { startLine: number; endLine: number; totalLines: number }; truncation: any; symbol: any; map: any; warnings: ReadseekWarning[] } | undefined;
			if (!readseekValue) {
				const lines = textContent.split("\n").filter(Boolean).length || textContent.split("\n").length;
				return new Text(summaryLine(`loaded ${lines} ${lines === 1 ? "line" : "lines"}`, { hidden: !!textContent && !expanded }), 0, 0);
			}

			const info = formatReadResultText({ range: readseekValue.range, truncation: readseekValue.truncation, symbol: readseekValue.symbol, map: readseekValue.map, warnings: readseekValue.warnings });
			const visibleLines = info.truncated && readseekValue.truncation ? readseekValue.truncation.outputLines : readseekValue.range.endLine - readseekValue.range.startLine + 1;
			const loadedWord = visibleLines === 1 ? "line" : "lines";
			const summaryParts: string[] = [info.truncated ? `loaded ${visibleLines} of ${readseekValue.truncation?.totalLines ?? readseekValue.range.totalLines} ${loadedWord} (truncated)` : `loaded ${visibleLines} ${loadedWord}`];
			if (info.symbolBadge) summaryParts.push(info.symbolBadge);
			for (const badge of info.badges) summaryParts.push(badge);
			const summary = summaryParts.join(" • ");
			let text = summaryLine(summary, { hidden: !!textContent && !expanded });
			if (expanded && textContent) text += "\n" + wrapReadHashlinesForWidth(textContent, width);
			return new Text(clampLinesToWidth(text.split("\n"), width).join("\n"), 0, 0);
		},
	} satisfies Parameters<ExtensionAPI["registerTool"]>[0] & { ptc: typeof toolConfig };

	pi.registerTool(tool);
	return tool;
}
