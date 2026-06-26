import { spawn, type StdioOptions } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

import { DetailLevel } from "./readseek/enums.js";
import type { FileMap, FileSymbol } from "./readseek/types.js";
import { SymbolKind } from "./readseek/enums.js";

export interface ReadSeekHashline {
	line: number;
	hash: string;
	text: string;
}

interface ReadSeekReadOutput {
	file: string;
	language: string;
	line_count: number;
	file_hash: string;
	start_line: number;
	end_line: number;
	hashlines: ReadSeekHashline[];
}

interface ReadSeekSymbol {
	kind: string;
	name: string;
	qualified_name: string;
	start_line: number;
	end_line: number;
	start_hash: string;
	end_hash: string;
}

interface ReadSeekMapOutput {
	file: string;
	language: string;
	line_count: number;
	file_hash: string;
	symbols: ReadSeekSymbol[];
}

interface ReadSeekSearchCapture {
	name: string;
	start_line: number;
	end_line: number;
	start_hash: string;
	end_hash: string;
	hashlines: ReadSeekHashline[];
}

interface ReadSeekSearchMatch {
	pattern_index: number;
	start_line: number;
	end_line: number;
	start_hash: string;
	end_hash: string;
	hashlines: ReadSeekHashline[];
	captures: ReadSeekSearchCapture[];
}

export interface ReadSeekSearchFileOutput {
	file: string;
	language: string;
	file_hash: string;
	matches: ReadSeekSearchMatch[];
}

interface ReadSeekSearchOutput {
	results: ReadSeekSearchFileOutput[];
}

export interface ReadSeekReference {
	file: string;
	line: number;
	column: number;
	line_hash: string;
	text: string;
	enclosingSymbol?: string;
}

interface ReadSeekRefsOutput {
	references: ReadSeekReference[];
}

interface ReadSeekRefsOptions {
	scope?: boolean;
	line?: number;
	column?: number;
	language?: string;
	cached?: boolean;
	others?: boolean;
	ignored?: boolean;
	signal?: AbortSignal;
}

export interface ReadSeekDiagnostic {
	kind: "error" | "missing";
	start_line: number;
	end_line: number;
}

export interface ReadSeekCheckOutput {
	errorCount: number;
	missingCount: number;
	diagnostics: ReadSeekDiagnostic[];
}

interface ReadSeekSearchOptions {
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

function symbolsFromReadSeek(symbols: ReadSeekSymbol[]): FileSymbol[] {
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
const READSEEK_REPO_PACKAGE_NAMES = new Set(["@jarkkojs/readseek", "readseek"]);
let defaultReadSeekDirInit: Promise<string | null> | undefined;

function readseekPackageDir(): string {
	return path.dirname(require.resolve("@jarkkojs/readseek/package.json"));
}

function readseekBinaryPath(): string {
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

export function isReadSeekAvailable(): boolean {
	try {
		readseekBinaryPath();
		return true;
	} catch {
		return false;
	}
}

interface ReadSeekFailure {
	code: "readseek-not-installed" | "readseek-execution-error";
	message: string;
	hint?: string;
}

/**
 * Classify an error thrown while invoking readseek into the shared failure
 * taxonomy: a missing binary or package (`readseek-not-installed`, with an
 * install hint) versus any other execution error.
 */
export function classifyReadSeekFailure(err: unknown): ReadSeekFailure {
	const message = String((err as { message?: unknown } | null)?.message || err);
	const missing =
		(err as { code?: unknown } | null)?.code === "ENOENT" ||
		/Cannot find package|Cannot find module|no such file/i.test(message);
	if (missing) {
		return { code: "readseek-not-installed", message, hint: "Run npm install to install @jarkkojs/readseek." };
	}
	return { code: "readseek-execution-error", message };
}

function directoryExists(dirPath: string): boolean {
	try {
		return statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

function isOwnReadSeekRepository(cwd = process.cwd()): boolean {
	let dir = path.resolve(cwd);
	while (true) {
		const packageJsonPath = path.join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			try {
				const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
				if (typeof packageJson.name === "string" && READSEEK_REPO_PACKAGE_NAMES.has(packageJson.name)) return true;
			} catch {
				// Ignore unreadable or invalid package manifests while walking up.
			}
		}

		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

function defaultReadSeekDir(): string | null {
	const home = homedir();
	return home ? path.join(home, ".pi", "readseek") : null;
}

async function spawnReadSeekRaw(args: string[], options: RunReadSeekOptions = {}): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const succeed = (value: string): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const stdin = options.stdin;
		const stdio: StdioOptions = [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"];
		const child = spawn(readseekBinaryPath(), args, { stdio, signal: options.signal });
		const childStdout = child.stdout;
		const childStderr = child.stderr;
		const childStdin = child.stdin;
		if (!childStdout || !childStderr) {
			child.kill();
			fail(new Error("readseek stdio streams are unavailable"));
			return;
		}
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;

		childStdout.on("data", (chunk: Buffer) => {
			if (settled) return;
			stdoutBytes += chunk.length;
			if (stdoutBytes > 32 * 1024 * 1024) {
				child.kill();
				fail(new Error("readseek output exceeded 32 MiB"));
				return;
			}
			stdoutChunks.push(chunk);
		});
		childStderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		child.on("error", (error: any) => fail(error));
		if (stdin !== undefined) {
			if (!childStdin) {
				child.kill();
				fail(new Error("readseek stdin stream is unavailable"));
				return;
			}
			childStdin.on("error", (error: any) => {
				if (error?.code !== "EPIPE") fail(error);
			});
			childStdin.end(stdin, "utf-8");
		}
		child.on("close", (code) => {
			const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
			const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
			if (code === 0) succeed(stdout);
			else fail(new Error((stderr || `readseek exited with status ${code}`).replace(/^error:\s*/i, "")));
		});
	});
}

async function ensureDefaultReadSeekDir(): Promise<string | null> {
	const dir = defaultReadSeekDir();
	if (!dir) return null;
	if (directoryExists(dir)) return dir;

	defaultReadSeekDirInit ??= spawnReadSeekRaw(["--readseek-dir", dir, "init"])
		.then(() => (directoryExists(dir) ? dir : null))
		.catch(() => null)
		.finally(() => {
			defaultReadSeekDirInit = undefined;
		});
	return defaultReadSeekDirInit;
}

async function readseekInvocationArgs(args: string[]): Promise<string[]> {
	if (isOwnReadSeekRepository()) return args;

	const readseekDir = await ensureDefaultReadSeekDir();
	return readseekDir ? ["--readseek-dir", readseekDir, ...args] : args;
}

interface RunReadSeekOptions {
	signal?: AbortSignal;
	stdin?: string;
}

async function runReadSeekRaw(args: string[], options: RunReadSeekOptions = {}): Promise<string> {
	return spawnReadSeekRaw(await readseekInvocationArgs(args), options);
}

async function runReadSeek(args: string[], options: RunReadSeekOptions = {}): Promise<unknown> {
	const stdout = await runReadSeekRaw(args, options);
	return JSON.parse(stdout) as unknown;
}

function requireNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`invalid readseek ${field}: expected safe integer`);
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`invalid readseek ${field}`);
	return value;
}

function parseReadOutput(value: unknown): ReadSeekReadOutput {
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
		hashlines: hashlines.map((line) => parseHashline(line, "hashline")),
	};
}

function parseMapOutput(value: unknown): ReadSeekMapOutput {
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

function parseHashline(value: unknown, field: string): ReadSeekHashline {
	if (!value || typeof value !== "object") throw new Error(`invalid readseek ${field}`);
	const item = value as Record<string, unknown>;
	return {
		line: requireNumber(item.line, `${field}.line`),
		hash: requireString(item.hash, `${field}.hash`),
		text: requireString(item.text, `${field}.text`),
	};
}

function parseSearchHashlines(value: unknown, field: string): ReadSeekHashline[] {
	if (!Array.isArray(value)) throw new Error(`invalid readseek ${field}`);
	return value.map((line) => parseHashline(line, field));
}

function parseSearchOutput(value: unknown): ReadSeekSearchOutput {
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
						pattern_index: item.pattern_index === undefined ? 0 : requireNumber(item.pattern_index, "search.match.pattern_index"),
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

export async function readseekRead(filePath: string, startLine?: number, endLine?: number): Promise<ReadSeekReadOutput> {
	const args = ["read", filePath];
	if (startLine !== undefined) args.push("--start", String(startLine));
	if (endLine !== undefined) args.push("--end", String(endLine));
	return parseReadOutput(await runReadSeek(args));
}

function fileMapFromReadSeekOutput(output: ReadSeekMapOutput, filePath: string, totalBytes: number): FileMap | null {
	if (output.language === "unknown" && output.symbols.length === 0) return null;
	return {
		path: filePath,
		totalLines: output.line_count,
		totalBytes,
		language: normalizeLanguage(output.language),
		detailLevel: DetailLevel.Full,
		imports: [],
		symbols: symbolsFromReadSeek(output.symbols),
	};
}

export async function readseekMap(
	filePath: string,
	totalBytes: number,
	options: { signal?: AbortSignal } = {},
): Promise<FileMap | null> {
	const output = parseMapOutput(await runReadSeek(["map", filePath], { signal: options.signal }));
	return fileMapFromReadSeekOutput(output, filePath, totalBytes);
}

export async function readseekSearch(
	target: string,
	pattern: string,
	options: ReadSeekSearchOptions = {},
): Promise<ReadSeekSearchFileOutput[]> {
	const args = ["search", target, pattern];
	if (options.language) args.push("--language", options.language);
	if (options.cached) args.push("--cached");
	if (options.others) args.push("--others");
	if (options.ignored) args.push("--ignored");
	return parseSearchOutput(await runReadSeek(args, { signal: options.signal })).results;
}

export async function readseekMapContent(
	filePath: string,
	content: string,
	options: { signal?: AbortSignal } = {},
): Promise<FileMap | null> {
	const output = parseMapOutput(
		await runReadSeek(["map", "--stdin", filePath], { signal: options.signal, stdin: content }),
	);
	return fileMapFromReadSeekOutput(output, filePath, Buffer.byteLength(content, "utf8"));
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireString(value, field);
}

function parseRefsOutput(value: unknown): ReadSeekRefsOutput {
	if (!value || typeof value !== "object") throw new Error("invalid readseek refs output");
	const output = value as Record<string, unknown>;
	if (!Array.isArray(output.references)) throw new Error("invalid readseek references");
	return {
		references: output.references.map((reference) => {
			if (!reference || typeof reference !== "object") throw new Error("invalid readseek reference");
			const item = reference as Record<string, unknown>;
			const symbol = item.symbol;
			const enclosing =
				symbol && typeof symbol === "object"
					? optionalString((symbol as Record<string, unknown>).qualified_name, "reference.symbol.qualified_name")
					: undefined;
			return {
				file: requireString(item.file, "reference.file"),
				line: requireNumber(item.line, "reference.line"),
				column: requireNumber(item.column, "reference.column"),
				line_hash: requireString(item.line_hash, "reference.line_hash"),
				text: requireString(item.text, "reference.text"),
				enclosingSymbol: enclosing,
			};
		}),
	};
}

export async function readseekRefs(
	target: string,
	name: string,
	options: ReadSeekRefsOptions = {},
): Promise<ReadSeekReference[]> {
	const args = ["refs", target, name];
	if (options.scope) args.push("--scope");
	if (options.line !== undefined) args.push("--line", String(options.line));
	if (options.column !== undefined) args.push("--column", String(options.column));
	if (options.language) args.push("--language", options.language);
	if (options.cached) args.push("--cached");
	if (options.others) args.push("--others");
	if (options.ignored) args.push("--ignored");
	return parseRefsOutput(await runReadSeek(args, { signal: options.signal })).references;
}

function parseDiagnosticKind(value: unknown): ReadSeekDiagnostic["kind"] {
	if (value === "error" || value === "missing") return value;
	throw new Error("invalid readseek diagnostic.kind");
}

function parseCheckOutput(value: unknown): ReadSeekCheckOutput {
	if (!value || typeof value !== "object") throw new Error("invalid readseek check output");
	const output = value as Record<string, unknown>;
	if (!Array.isArray(output.diagnostics)) throw new Error("invalid readseek diagnostics");
	return {
		errorCount: requireNumber(output.error_count, "error_count"),
		missingCount: requireNumber(output.missing_count, "missing_count"),
		diagnostics: output.diagnostics.map((diagnostic) => {
			if (!diagnostic || typeof diagnostic !== "object") throw new Error("invalid readseek diagnostic");
			const item = diagnostic as Record<string, unknown>;
			return {
				kind: parseDiagnosticKind(item.kind),
				start_line: requireNumber(item.start_line, "diagnostic.start_line"),
				end_line: requireNumber(item.end_line, "diagnostic.end_line"),
			};
		}),
	};
}

export async function readseekCheck(
	filePath: string,
	content: string,
	options: { signal?: AbortSignal } = {},
): Promise<ReadSeekCheckOutput> {
	return parseCheckOutput(
		await runReadSeek(["check", "--stdin", filePath], { signal: options.signal, stdin: content }),
	);
}
