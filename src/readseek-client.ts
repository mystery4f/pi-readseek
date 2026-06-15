import { spawn, type StdioOptions } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { DetailLevel } from "./readseek/enums.js";
import type { FileMap, FileSymbol } from "./readseek/types.js";
import { SymbolKind } from "./readseek/enums.js";

export interface ReadseekHashline {
	line: number;
	hash: string;
	text: string;
}

export interface ReadseekReadOutput {
	file: string;
	language: string;
	line_count: number;
	file_hash: string;
	start_line: number;
	end_line: number;
	hashlines: ReadseekHashline[];
}

interface ReadseekSymbol {
	kind: string;
	name: string;
	qualified_name: string;
	start_line: number;
	end_line: number;
	start_hash: string;
	end_hash: string;
}

interface ReadseekMapOutput {
	file: string;
	language: string;
	line_count: number;
	file_hash: string;
	symbols: ReadseekSymbol[];
}

export interface ReadseekSearchCapture {
	name: string;
	start_line: number;
	end_line: number;
	start_hash: string;
	end_hash: string;
	hashlines: ReadseekHashline[];
}

export interface ReadseekSearchMatch {
	pattern_index: number;
	start_line: number;
	end_line: number;
	start_hash: string;
	end_hash: string;
	hashlines: ReadseekHashline[];
	captures: ReadseekSearchCapture[];
}

export interface ReadseekSearchFileOutput {
	file: string;
	language: string;
	file_hash: string;
	matches: ReadseekSearchMatch[];
}

interface ReadseekSearchOutput {
	results: ReadseekSearchFileOutput[];
}

export interface ReadseekSearchOptions {
	language?: string;
	cached?: boolean;
	others?: boolean;
	ignored?: boolean;
	signal?: AbortSignal;
}

function normalizeLanguage(language: string): string {
	return language === "java" ? "Java" : language;
}

function normalizeKind(kind: string): FileSymbol["kind"] {
	if (kind === "constructor") return SymbolKind.Method;
	if (Object.values(SymbolKind).includes(kind as SymbolKind)) return kind as FileSymbol["kind"];
	return SymbolKind.Unknown;
}

function parentQualifiedNameFor(qualifiedName: string): string {
	const lastDot = qualifiedName.lastIndexOf(".");
	return lastDot === -1 ? "" : qualifiedName.slice(0, lastDot);
}

function symbolsFromReadseek(symbols: ReadseekSymbol[]): FileSymbol[] {
	const symbolsByQualifiedName = new Map<string, FileSymbol[]>();
	const entries: Array<{ parentQualifiedName: string; symbol: FileSymbol }> = [];

	for (const symbol of symbols) {
		const parentQualifiedName = parentQualifiedNameFor(symbol.qualified_name);
		const fileSymbol: FileSymbol = {
			name: symbol.name,
			kind: normalizeKind(symbol.kind),
			startLine: symbol.start_line,
			endLine: symbol.end_line,
		};
		const bucket = symbolsByQualifiedName.get(symbol.qualified_name);
		if (bucket) bucket.push(fileSymbol);
		else symbolsByQualifiedName.set(symbol.qualified_name, [fileSymbol]);
		entries.push({ parentQualifiedName, symbol: fileSymbol });
	}

	const roots: FileSymbol[] = [];
	for (const entry of entries) {
		const parent = entry.parentQualifiedName
			? symbolsByQualifiedName.get(entry.parentQualifiedName)?.[0]
			: undefined;
		if (!parent) {
			roots.push(entry.symbol);
			continue;
		}

		parent.children ??= [];
		parent.children.push(entry.symbol);
	}

	return roots;
}

const require = createRequire(import.meta.url);

function readseekPackageDir(): string {
	return path.dirname(require.resolve("@jarkkojs/readseek/package.json"));
}

export function readseekBinaryPath(): string {
	if (process.env.READSEEK_BIN) return process.env.READSEEK_BIN;

	const platformPackage = (() => {
		switch (process.platform) {
			case "darwin":
				return "@jarkkojs/readseek-darwin-arm64";
			case "linux":
				return "@jarkkojs/readseek-linux-x64";
			case "win32":
				return "@jarkkojs/readseek-win32-x64";
			default:
				throw new Error(`unsupported readseek platform: ${process.platform}`);
		}
	})();

	const packageJson = require.resolve(`${platformPackage}/package.json`, { paths: [readseekPackageDir()] });
	return path.join(path.dirname(packageJson), "bin", process.platform === "win32" ? "readseek.exe" : "readseek");
}

export function isReadseekAvailable(): boolean {
	try {
		readseekBinaryPath();
		return true;
	} catch {
		return false;
	}
}

interface RunReadseekOptions {
	signal?: AbortSignal;
	stdin?: string;
}

async function runReadseekRaw(args: string[], options: RunReadseekOptions = {}): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const stdin = options.stdin;
		const stdio: StdioOptions = [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"];
		const child = spawn(readseekBinaryPath(), args, { stdio, signal: options.signal });
		const childStdout = child.stdout;
		const childStderr = child.stderr;
		const childStdin = child.stdin;
		if (!childStdout || !childStderr) {
			child.kill();
			reject(new Error("readseek stdio streams are unavailable"));
			return;
		}
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;

		childStdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > 32 * 1024 * 1024) {
				child.kill();
				reject(new Error("readseek output exceeded 32 MiB"));
				return;
			}
			stdoutChunks.push(chunk);
		});
		childStderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		child.on("error", (error: any) => reject(error));
		if (stdin !== undefined) {
			if (!childStdin) {
				child.kill();
				reject(new Error("readseek stdin stream is unavailable"));
				return;
			}
			childStdin.on("error", (error: any) => {
				if (error?.code !== "EPIPE") reject(error);
			});
			childStdin.end(stdin, "utf-8");
		}
		child.on("close", (code) => {
			const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
			const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
			if (code === 0) resolve(stdout);
			else reject(new Error((stderr || `readseek exited with status ${code}`).replace(/^error:\s*/i, "")));
		});
	});
}

async function runReadseek(args: string[], options: RunReadseekOptions = {}): Promise<unknown> {
	const stdout = await runReadseekRaw(args, options);
	return JSON.parse(stdout) as unknown;
}

function requireNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid readseek ${field}`);
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`invalid readseek ${field}`);
	return value;
}

function parseReadOutput(value: unknown): ReadseekReadOutput {
	if (!value || typeof value !== "object") throw new Error("invalid readseek read output");
	const output = value as Record<string, unknown>;
	const hashlines = output.hashlines;
	if (!Array.isArray(hashlines)) throw new Error("invalid readseek hashlines");
	return {
		file: requireString(output.file, "file"),
		language: requireString(output.language, "language"),
		line_count: requireNumber(output.line_count, "line_count"),
		file_hash: requireString(output.file_hash, "file_hash"),
		start_line: requireNumber(output.start_line, "start_line"),
		end_line: requireNumber(output.end_line, "end_line"),
		hashlines: hashlines.map((line) => {
			if (!line || typeof line !== "object") throw new Error("invalid readseek hashline");
			const item = line as Record<string, unknown>;
			return {
				line: requireNumber(item.line, "hashline.line"),
				hash: requireString(item.hash, "hashline.hash"),
				text: requireString(item.text, "hashline.text"),
			};
		}),
	};
}

function parseMapOutput(value: unknown): ReadseekMapOutput {
	if (!value || typeof value !== "object") throw new Error("invalid readseek map output");
	const output = value as Record<string, unknown>;
	const symbols = output.symbols;
	if (!Array.isArray(symbols)) throw new Error("invalid readseek symbols");
	return {
		file: requireString(output.file, "file"),
		language: requireString(output.language, "language"),
		line_count: requireNumber(output.line_count, "line_count"),
		file_hash: requireString(output.file_hash, "file_hash"),
		symbols: symbols.map((symbol) => {
			if (!symbol || typeof symbol !== "object") throw new Error("invalid readseek symbol");
			const item = symbol as Record<string, unknown>;
			return {
				kind: requireString(item.kind, "symbol.kind"),
				name: requireString(item.name, "symbol.name"),
				qualified_name: requireString(item.qualified_name, "symbol.qualified_name"),
				start_line: requireNumber(item.start_line, "symbol.start_line"),
				end_line: requireNumber(item.end_line, "symbol.end_line"),
				start_hash: requireString(item.start_hash, "symbol.start_hash"),
				end_hash: requireString(item.end_hash, "symbol.end_hash"),
			};
		}),
	};
}

function parseSearchHashlines(value: unknown, field: string): ReadseekHashline[] {
	if (!Array.isArray(value)) throw new Error(`invalid readseek ${field}`);
	return value.map((line) => {
		if (!line || typeof line !== "object") throw new Error(`invalid readseek ${field}`);
		const item = line as Record<string, unknown>;
		return {
			line: requireNumber(item.line, `${field}.line`),
			hash: requireString(item.hash, `${field}.hash`),
			text: requireString(item.text, `${field}.text`),
		};
	});
}

function parseSearchOutput(value: unknown): ReadseekSearchOutput {
	if (!value || typeof value !== "object") throw new Error("invalid readseek search output");
	const output = value as Record<string, unknown>;
	if (!Array.isArray(output.results)) throw new Error("invalid readseek search results");
	return {
		results: output.results.map((result) => {
			if (!result || typeof result !== "object") throw new Error("invalid readseek search result");
			const file = result as Record<string, unknown>;
			if (!Array.isArray(file.matches)) throw new Error("invalid readseek search matches");
			return {
				file: requireString(file.file, "search.file"),
				language: requireString(file.language, "search.language"),
				file_hash: requireString(file.file_hash, "search.file_hash"),
				matches: file.matches.map((match) => {
					if (!match || typeof match !== "object") throw new Error("invalid readseek search match");
					const item = match as Record<string, unknown>;
					if (!Array.isArray(item.captures)) throw new Error("invalid readseek search captures");
					return {
						pattern_index: requireNumber(item.pattern_index, "search.match.pattern_index"),
						start_line: requireNumber(item.start_line, "search.match.start_line"),
						end_line: requireNumber(item.end_line, "search.match.end_line"),
						start_hash: requireString(item.start_hash, "search.match.start_hash"),
						end_hash: requireString(item.end_hash, "search.match.end_hash"),
						hashlines: parseSearchHashlines(item.hashlines, "search.match.hashlines"),
						captures: item.captures.map((capture) => {
							if (!capture || typeof capture !== "object") throw new Error("invalid readseek search capture");
							const captureItem = capture as Record<string, unknown>;
							return {
								name: requireString(captureItem.name, "search.capture.name"),
								start_line: requireNumber(captureItem.start_line, "search.capture.start_line"),
								end_line: requireNumber(captureItem.end_line, "search.capture.end_line"),
								start_hash: requireString(captureItem.start_hash, "search.capture.start_hash"),
								end_hash: requireString(captureItem.end_hash, "search.capture.end_hash"),
								hashlines: parseSearchHashlines(captureItem.hashlines, "search.capture.hashlines"),
							};
						}),
					};
				}),
			};
		}),
	};
}

export async function readseekRead(filePath: string, startLine?: number, endLine?: number): Promise<ReadseekReadOutput> {
	const args = ["read", filePath];
	if (startLine !== undefined) args.push("--offset", String(startLine));
	if (endLine !== undefined) args.push("--end", String(endLine));
	return parseReadOutput(await runReadseek(args));
}

function fileMapFromReadseekOutput(output: ReadseekMapOutput, filePath: string, totalBytes: number): FileMap | null {
	if (output.language === "unknown" && output.symbols.length === 0) return null;
	return {
		path: filePath,
		totalLines: output.line_count,
		totalBytes,
		language: normalizeLanguage(output.language),
		detailLevel: DetailLevel.Full,
		imports: [],
		symbols: symbolsFromReadseek(output.symbols),
	};
}

export async function readseekMap(
	filePath: string,
	totalBytes: number,
	options: { signal?: AbortSignal } = {},
): Promise<FileMap | null> {
	const output = parseMapOutput(await runReadseek(["map", filePath], { signal: options.signal }));
	return fileMapFromReadseekOutput(output, filePath, totalBytes);
}

export async function readseekSearch(
	target: string,
	pattern: string,
	options: ReadseekSearchOptions = {},
): Promise<ReadseekSearchFileOutput[]> {
	const args = ["search", target, pattern];
	if (options.language) args.push("--language", options.language);
	if (options.cached) args.push("--cached");
	if (options.others) args.push("--others");
	if (options.ignored) args.push("--ignored");
	return parseSearchOutput(await runReadseek(args, { signal: options.signal })).results;
}

export async function readseekMapContent(
	filePath: string,
	content: string,
	options: { signal?: AbortSignal } = {},
): Promise<FileMap | null> {
	const output = parseMapOutput(
		await runReadseek(["map", "--stdin", "--path", filePath], { signal: options.signal, stdin: content }),
	);
	return fileMapFromReadseekOutput(output, filePath, Buffer.byteLength(content, "utf8"));
}
