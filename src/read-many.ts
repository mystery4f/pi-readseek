import { readFile as fsReadFile } from "node:fs/promises";
import { relative as relativePath, isAbsolute } from "node:path";

import type { ExtensionAPI, ToolRenderResultOptions, AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";

import { defineToolPromptMetadata } from "./tool-prompt-metadata.js";
import { normalizeToLF, stripBom, hasBareCarriageReturn } from "./edit-diff.js";
import { ensureHashInit, escapeControlCharsForDisplay } from "./hashline.js";
import { buildReadSeekWarning, buildToolErrorResult, renderReadSeekLines, type ReadSeekLine, type ReadSeekWarning } from "./readseek-value.js";
import { looksLikeBinary } from "./binary-detect.js";
import { resolveToCwd } from "./path-utils.js";
import { throwIfAborted } from "./runtime.js";
import { formatFsError } from "./fs-error.js";
import { coerceObviousBase10Int } from "./coerce-obvious-int.js";
import { readseekRead, readseekDetect, type ReadSeekDetection } from "./readseek-client.js";
import { resolveReadSeekOcrMode } from "./readseek-settings.js";
import {
	clampLineToWidth,
	clampLinesToWidth,
	linkToolPath,
	renderPendingResult,
	renderToolLabel,
	resolveRenderResultContext,
	summaryLine,
} from "./tui-render-utils.js";
import type { FileAnchoredCallback } from "./tool-types.js";
import { filePathParam, optionalIntOrString, registerReadSeekTool } from "./register-tool.js";

const READ_MANY_PROMPT_METADATA = defineToolPromptMetadata({
	promptUrl: new URL("../prompts/read-many.md", import.meta.url),
	promptSnippet: "Read multiple files in one call with per-file offset/limit; combined output uses per-file LINE:HASH anchor blocks under a shared budget",
});

interface ReadManyFileParams {
	path: string;
	offset?: number | string;
	limit?: number | string;
}

interface ReadManyParams {
	files: ReadManyFileParams[];
	stopOnError?: boolean;
}

interface ReadManyToolOptions {
	onSuccessfulRead?: FileAnchoredCallback;
}

export interface ExecuteReadManyOptions {
	toolCallId: string;
	params: unknown;
	signal: AbortSignal | undefined;
	onUpdate: any;
	cwd: string;
	onSuccessfulRead?: FileAnchoredCallback;
	/** Whether the active model accepts image input natively. Used when OCR mode is auto. */
	modelSupportsImages?: boolean;
}

/** A single file's resolved read outcome, in request order. */
type FileResult =
	| {
			kind: "text";
			index: number;
			rawPath: string;
			absolutePath: string;
			lines: ReadSeekLine[];
			startLine: number;
			endLine: number;
			totalLines: number;
			warnings: ReadSeekWarning[];
	  }
	| {
			kind: "summary";
			index: number;
			rawPath: string;
			absolutePath: string;
			summary: string;
			warnings: ReadSeekWarning[];
	  }
	| {
			kind: "error";
			index: number;
			rawPath: string;
			message: string;
	  };

interface RenderedBlock {
	result: FileResult;
	text: string;
	lineCount: number;
	byteCount: number;
}

const MAX_FILES = 26;

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const withoutTrailingTerminator = text.endsWith("\n") ? text.slice(0, -1) : text;
	return withoutTrailingTerminator.split("\n");
}

function displayPathFor(absolutePath: string, cwd: string, rawPath: string): string {
	const rel = relativePath(cwd, absolutePath);
	// relative() returns the rawPath-equivalent when already inside cwd; otherwise
	// fall back to the user-supplied path (nicer than an unrelated absolute path).
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	return rawPath;
}

function formatImageAnalysis(detection: ReadSeekDetection): string | undefined {
	if (detection.kind !== "image") return undefined;
	const sections: string[] = [];
	const dimensions = `${detection.width}x${detection.height}${detection.animated ? " (animated)" : ""}`;
	sections.push(`[Image: ${detection.format} ${dimensions}]`);
	const transcript = detection.transcribe?.text?.trim();
	if (transcript) sections.push(`OCR text:\n${transcript}`);
	const caption = detection.caption?.trim();
	if (caption) sections.push(`Caption: ${caption}`);
	if (detection.objects?.length) {
		const lines = detection.objects.map((object) => `- ${object.label} [${object.bbox.join(", ")}]`);
		sections.push(`Detected objects:\n${lines.join("\n")}`);
	}
	return sections.join("\n");
}

/**
 * Read one file range through readseek and return anchored lines, a text
 * summary (images / other binary), or an error. Mirrors the text path of
 * `executeRead` but without per-file truncation, map, symbol, or bundle.
 */
async function readFileAnchoredRange(
	entry: ReadManyFileParams,
	index: number,
	cwd: string,
	signal: AbortSignal | undefined,
	opts: { modelSupportsImages?: boolean },
): Promise<FileResult> {
	const rawPath = entry.path.replace(/^@/, "");
	const absolutePath = resolveToCwd(rawPath, cwd);

	const offset = coerceObviousBase10Int(entry.offset, "offset");
	if (!offset.ok) {
		return { kind: "error", index, rawPath, message: offset.message };
	}
	const limit = coerceObviousBase10Int(entry.limit, "limit");
	if (!limit.ok) {
		return { kind: "error", index, rawPath, message: limit.message };
	}
	if (limit.value !== undefined && limit.value < 1) {
		return { kind: "error", index, rawPath, message: `Invalid limit: expected a positive integer, received ${limit.value}.` };
	}
	if (offset.value !== undefined && offset.value < 1) {
		return { kind: "error", index, rawPath, message: `Invalid offset: expected a positive integer, received ${offset.value}.` };
	}

	throwIfAborted(signal);

	let rawBuffer: Buffer;
	try {
		rawBuffer = await fsReadFile(absolutePath);
	} catch (err: any) {
		const { code, message } = formatFsError(err, "read-error");
		return { kind: "error", index, rawPath, message: `${code}: ${message.replace(/^read-error:\s*/, "")}` };
	}

	const warnings: ReadSeekWarning[] = [];

	if (looksLikeBinary(rawBuffer)) {
		let detection: ReadSeekDetection | undefined;
		try {
			detection = await readseekDetect(absolutePath, { signal });
		} catch {
			// detection is best-effort
		}
		if (detection?.kind === "image") {
			const ocrMode = resolveReadSeekOcrMode();
			const shouldTranscribe = ocrMode === "on" || (ocrMode === "auto" && !opts.modelSupportsImages);
			if (shouldTranscribe) {
				try {
					const rich = await readseekDetect(absolutePath, {
						transcribe: true,
						caption: true,
						objects: true,
						signal,
					});
					const analysis = formatImageAnalysis(rich);
					if (analysis) {
						return { kind: "summary", index, rawPath, absolutePath, summary: analysis, warnings };
					}
				} catch {
					warnings.push(buildReadSeekWarning("ocr-unavailable", "[Warning: local image analysis (OCR) unavailable]"));
				}
			}
			return {
				kind: "summary",
				index,
				rawPath,
				absolutePath,
				summary: `[Image: ${detection.format} ${detection.width}x${detection.height}${detection.animated ? " (animated)" : ""} — use read() for the attachment]`,
				warnings,
			};
		}
		warnings.push(buildReadSeekWarning("binary-content", "[Warning: file appears to be binary — skipped]"));
		return { kind: "summary", index, rawPath, absolutePath, summary: "[Binary file — use read() for image OCR or direct view]", warnings };
	}

	throwIfAborted(signal);

	const rawText = rawBuffer.toString("utf-8");
	const normalized = normalizeToLF(stripBom(rawText).text);
	const allLines = splitLines(normalized);
	const total = allLines.length;
	const startLine = offset.value ?? 1;
	const endIdx = limit.value !== undefined ? Math.min(startLine - 1 + limit.value, total) : total;

	if (offset.value !== undefined && startLine > total) {
		return { kind: "error", index, rawPath, message: `offset ${offset.value} is past end of file (${total} lines)` };
	}

	let readseekOutput: Awaited<ReturnType<typeof readseekRead>>;
	try {
		readseekOutput = total === 0
			? await readseekRead(absolutePath)
			: await readseekRead(absolutePath, startLine, endIdx);
	} catch (err: any) {
		const detail = err?.message ? ` — ${err.message}` : "";
		return { kind: "error", index, rawPath, message: `readseek failed while reading ${rawPath}${detail}` };
	}

	const expectedLineCount = Math.max(0, endIdx - startLine + 1);
	const invalidLine = readseekOutput.hashlines.find((line, i) => line.line !== startLine + i);
	if (readseekOutput.hashlines.length !== expectedLineCount || invalidLine) {
		const message = invalidLine
			? `readseek returned non-sequential line ${invalidLine.line} for requested range ${startLine}-${endIdx}`
			: `readseek returned ${readseekOutput.hashlines.length} lines for requested range ${startLine}-${endIdx} (${expectedLineCount} expected)`;
		return { kind: "error", index, rawPath, message };
	}

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

	return { kind: "text", index, rawPath, absolutePath, lines, startLine, endLine: endIdx, totalLines: total, warnings };
}

function renderBlock(result: FileResult, cwd: string): RenderedBlock {
	const headerPath = result.kind === "error" ? result.rawPath : displayPathFor(result.absolutePath, cwd, result.rawPath);

	if (result.kind === "error") {
		const text = `--- ${headerPath} ---\n[Error: ${result.message}]`;
		return { result, text, lineCount: 2, byteCount: Buffer.byteLength(text, "utf8") };
	}

	if (result.kind === "summary") {
		const warningText = result.warnings.map((w) => w.message).join("\n");
		const body = warningText ? `${warningText}\n${result.summary}` : result.summary;
		const text = `--- ${headerPath} ---\n${body}`;
		return { result, text, lineCount: text.split("\n").length, byteCount: Buffer.byteLength(text, "utf8") };
	}

	const rangeLabel = `(lines ${result.startLine}-${result.endLine} of ${result.totalLines})`;
	const warningBanner = result.warnings.length ? `${result.warnings.map((w) => w.message).join("\n\n")}\n\n` : "";
	const body = renderReadSeekLines(result.lines);
	const text = `--- ${headerPath} ${rangeLabel} ---\n${warningBanner}${body}`;
	return { result, text, lineCount: text.split("\n").length, byteCount: Buffer.byteLength(text, "utf8") };
}

interface PackingBudget {
	maxLines: number;
	maxBytes: number;
}

/**
 * Greedily select complete blocks (by index) that fit the budget. `blocks` is
 * iterated in the given order; each included block is counted fully plus a
 * `\n\n` separator before it (except the first).
 */
export function greedyPack(blocks: RenderedBlock[], budget: PackingBudget): Set<number> {
	const selected = new Set<number>();
	let usedLines = 0;
	let usedBytes = 0;
	for (const block of blocks) {
		const sepBytes = selected.size > 0 ? 2 : 0;
		if (usedLines + block.lineCount <= budget.maxLines && usedBytes + block.byteCount + sepBytes <= budget.maxBytes) {
			selected.add(block.result.index);
			usedLines += block.lineCount;
			usedBytes += block.byteCount + sepBytes;
		}
	}
	return selected;
}

/**
 * Adaptive packing: default to strict request order, but switch to a
 * smallest-first selection when it fits strictly more complete text files.
 * Error and summary blocks are always included (they are small metadata).
 * Returns the set of TEXT-block indices to include; everything else renders.
 */
export function selectTextBlocksAdaptive(blocks: RenderedBlock[], budget: PackingBudget): Set<number> {
	const textBlocks = blocks.filter((b) => b.result.kind === "text");
	if (textBlocks.length === 0) return new Set();

	const strict = greedyPack(textBlocks, budget);
	const smallestFirst = greedyPack([...textBlocks].sort((a, b) => a.byteCount - b.byteCount), budget);

	return smallestFirst.size > strict.size ? smallestFirst : strict;
}

export async function executeReadMany(opts: ExecuteReadManyOptions): Promise<AgentToolResult<any>> {
	const { toolCallId, params, signal, onUpdate, cwd, onSuccessfulRead } = opts;
	void toolCallId;
	void onUpdate;
	await ensureHashInit();
	const rawParams = params as ReadManyParams;
	const files = Array.isArray(rawParams.files) ? rawParams.files : [];
	const stopOnError = rawParams.stopOnError === true;

	if (files.length === 0) {
		return buildToolErrorResult("read_many", "invalid-params", "`files` must be a non-empty array.");
	}
	if (files.length > MAX_FILES) {
		return buildToolErrorResult("read_many", "invalid-params", `\`files\` must contain at most ${MAX_FILES} entries, received ${files.length}.`);
	}

	const budget: PackingBudget = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
	const results: FileResult[] = [];

	for (let i = 0; i < files.length; i++) {
		throwIfAborted(signal);
		const entry = files[i];
		if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
			results.push({ kind: "error", index: i, rawPath: String(entry?.path ?? ""), message: "Invalid file entry: expected a non-empty `path` string." });
			if (stopOnError) break;
			continue;
		}
		const result = await readFileAnchoredRange(entry, i, cwd, signal, { modelSupportsImages: opts.modelSupportsImages });
		results.push(result);
		if (result.kind !== "error" && onSuccessfulRead) {
			// text reads with anchors mark the file as editable this session
			if (result.kind === "text" && result.lines.length > 0) {
				onSuccessfulRead(result.absolutePath);
			}
		}
		if (result.kind === "error" && stopOnError) break;
	}

	const blocks = results.map((r) => renderBlock(r, cwd));
	const includedText = selectTextBlocksAdaptive(blocks, budget);

	// Build the combined body in request order: always include errors/summaries,
	// include a text block only when selected by the adaptive packing.
	const sectionBlocks: RenderedBlock[] = [];
	const omitted: string[] = [];
	for (const block of blocks) {
		if (block.result.kind === "text") {
			if (includedText.has(block.result.index)) {
				sectionBlocks.push(block);
			} else {
				omitted.push(displayPathFor(block.result.absolutePath, cwd, block.result.rawPath));
			}
		} else {
			sectionBlocks.push(block);
		}
	}

	let body = sectionBlocks.map((b) => b.text).join("\n\n");

	// Edge case: nothing fit at all (e.g. one huge file). Fall back to a
	// head-truncated view of the first text block so the caller sees something.
	if (body.length === 0 && blocks.some((b) => b.result.kind === "text")) {
		const firstText = blocks.find((b) => b.result.kind === "text");
		if (firstText) body = firstText.text;
	}

	const truncation = truncateHead(body, budget);
	let text = truncation.content;
	let truncatedOverall = truncation.truncated;

	const footerParts: string[] = [];
	if (truncatedOverall) {
		footerParts.push(
			`[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Re-read individual files with read() or narrow offset/limit.]`,
		);
	}
	if (omitted.length > 0) {
		footerParts.push(`[Omitted (budget): ${omitted.join(", ")} — re-read individually or narrow offset/limit.]`);
	}
	if (footerParts.length > 0) {
		text += `\n\n${footerParts.join("\n")}`;
	}

	const fileMeta = results.map((r) => {
		if (r.kind === "text") {
			return {
				path: r.absolutePath,
				ok: true as const,
				range: { startLine: r.startLine, endLine: r.endLine, totalLines: r.totalLines },
				lines: r.lines,
			};
		}
		if (r.kind === "summary") {
			return { path: r.absolutePath, ok: true as const, summary: true };
		}
		return { path: r.rawPath, ok: false as const, error: r.message };
	});

const totalLines = results.reduce((sum, r) => r.kind === "text" ? sum + r.endLine - r.startLine + 1 : sum, 0);
	const errorCount = fileMeta.filter((f) => !f.ok).length;

	return {
		content: [{ type: "text", text }],
		details: {
			truncation: truncatedOverall ? truncation : undefined,
			readseekValue: {
				tool: "read_many",
				files: fileMeta,
				omitted,
				truncated: truncatedOverall,
				summary: {
					files: results.length,
					lines: totalLines,
					errors: errorCount,
				},
			},
		},
	};
}


export function registerReadManyTool(pi: ExtensionAPI, options: ReadManyToolOptions = {}) {
	const tool = registerReadSeekTool(pi, {
		policy: "read-only",
		pythonName: "read_many",
		defaultExposure: "safe-by-default",
	}, {
		name: "read_many",
		label: "Read Many",
		description: READ_MANY_PROMPT_METADATA.description,
		promptSnippet: READ_MANY_PROMPT_METADATA.promptSnippet,
		promptGuidelines: READ_MANY_PROMPT_METADATA.promptGuidelines,
		parameters: Type.Object({
			files: Type.Array(
				Type.Object({
					path: filePathParam(),
					offset: optionalIntOrString("Start line (1-indexed)"),
					limit: optionalIntOrString("Max lines"),
				}),
				{ minItems: 1, maxItems: MAX_FILES, description: "Files to read, in render order (max 26)" },
			),
			stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first file error (default false)" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return executeReadMany({
				toolCallId,
				params,
				signal,
				onUpdate,
				cwd: ctx.cwd,
				onSuccessfulRead: options.onSuccessfulRead,
				modelSupportsImages: ctx.model?.input.includes("image") ?? false,
			});
		},
		renderCall(args: any, theme: any, ...rest: any[]) {
			const context = rest[0] ?? {};
			const cwd = context.cwd ?? process.cwd();
			const fileList = Array.isArray(args?.files) ? args.files : [];
			const label = renderToolLabel(theme, "read_many");
			if (fileList.length === 0) {
				return new Text(clampLineToWidth(`${label} ${theme.fg("toolOutput", "...")}`, context.width), 0, 0);
			}
			const paths = fileList.map((f: { path?: string }) => f?.path).filter(Boolean);
			const first = paths[0];
			const summary = paths.length > 1 ? ` +${paths.length - 1} more` : "";
			const text = `${label} ${linkToolPath(theme.fg("accent", `${first}${summary}`), first, cwd)}`;
			return new Text(clampLineToWidth(text, context.width), 0, 0);
		},
		renderResult(result: any, options: ToolRenderResultOptions, theme: any, ...rest: any[]) {
			const { isPartial, isError, expanded, width } = resolveRenderResultContext(options, rest);
			if (isPartial) return renderPendingResult("pending read_many", width);

			const content = result.content?.[0];
			const textContent = content?.type === "text" ? content.text : "";
			if (isError || result.isError) {
				const firstLine = textContent.split("\n")[0] || "Error";
				const errorText = expanded ? (textContent || firstLine) : firstLine;
				return new Text(clampLinesToWidth([summaryLine(errorText)], width).join("\n"), 0, 0);
			}

			const value = (result.details as any)?.readseekValue as
				| { summary?: { files?: number; lines?: number; errors?: number }; truncated?: boolean }
				| undefined;
			if (!value) {
				const lines = textContent.split("\n").filter(Boolean).length || 1;
				return new Text(summaryLine(`loaded ${lines} lines`, { hidden: !!textContent && !expanded }), 0, 0);
			}

			const s = value.summary ?? {};
			const parts: string[] = [];
			const fileCount = s.files ?? 0;
			parts.push(`loaded ${fileCount} ${fileCount === 1 ? "file" : "files"}`);
			if (typeof s.lines === "number" && s.lines > 0) parts.push(`${s.lines} lines`);
			if (typeof s.errors === "number" && s.errors > 0) parts.push(`${s.errors} ${s.errors === 1 ? "error" : "errors"}`);
			if (value.truncated) parts.push("truncated");

			let text = summaryLine(parts.join(" • "), { hidden: !!textContent && !expanded });
			if (expanded && textContent) text += "\n" + clampLinesToWidth(textContent.split("\n"), width).join("\n");
			return new Text(clampLinesToWidth(text.split("\n"), width).join("\n"), 0, 0);
		},
	});
	return tool;
}