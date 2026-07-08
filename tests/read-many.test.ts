import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { readseekReadMock, readseekDetectMock } = vi.hoisted(() => ({
	readseekReadMock: vi.fn(),
	readseekDetectMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => ({
	...(await import("./support/pi-coding-agent-mock.js")).createPiCodingAgentBaseMock(),
}));

vi.mock("../src/readseek-client.js", () => ({
	readseekRead: readseekReadMock,
	readseekDetect: readseekDetectMock,
}));

const { executeReadMany, greedyPack, selectTextBlocksAdaptive } = await import("../src/read-many.js");

/**
 * Stub readseek to return deterministic hashlines derived from the file bytes.
 * Each input line gets a stable hash like "h<line>". This mirrors how the read
 * tool's tests stub the native backend.
 */
function mockReadForFile(filePath: string, lines: string[]) {
	readseekReadMock.mockImplementation(async (p: string, start?: number, end?: number) => {
		if (p !== filePath) throw new Error(`unexpected readseek path ${p}`);
		const startLine = start ?? 1;
		const endLine = end ?? lines.length;
		const slice = lines.slice(startLine - 1, endLine);
		return {
			file: filePath,
			language: "Text",
			line_count: lines.length,
			file_hash: "filehash",
			start_line: startLine,
			end_line: endLine,
			hashlines: slice.map((text, i) => ({ line: startLine + i, hash: `h${startLine + i}`, text })),
		};
	});
}

function textOf(result: any): string {
	return (result.content as Array<{ type: string; text: string }>).map((p) => p.text).join("\n");
}

describe("executeReadMany", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reads multiple files with per-file anchored sections", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-many-"));
		try {
			const a = path.join(cwd, "a.txt");
			const b = path.join(cwd, "b.txt");
			await writeFile(a, "alpha\nbeta\n", "utf8");
			await writeFile(b, "gamma\ndelta\n", "utf8");

			let calls = 0;
			readseekReadMock.mockImplementation(async (p: string, start?: number, end?: number) => {
				calls++;
				const map: Record<string, string[]> = { [a]: ["alpha", "beta"], [b]: ["gamma", "delta"] };
				const lines = map[p]!;
				const startLine = start ?? 1;
				const endLine = end ?? lines.length;
				const slice = lines.slice(startLine - 1, endLine);
				return {
					file: p, language: "Text", line_count: lines.length, file_hash: "fh",
					start_line: startLine, end_line: endLine,
					hashlines: slice.map((text, i) => ({ line: startLine + i, hash: `h${startLine + i}`, text })),
				};
			});

			const result = await executeReadMany({
				toolCallId: "t",
				params: { files: [{ path: "a.txt" }, { path: "b.txt" }] },
				signal: undefined,
				onUpdate: undefined,
				cwd,
			});

			const text = textOf(result);
			expect(text).toContain("--- a.txt (lines 1-2 of 2) ---");
			expect(text).toContain("1:h1|alpha");
			expect(text).toContain("2:h2|beta");
			expect(text).toContain("--- b.txt (lines 1-2 of 2) ---");
			expect(text).toContain("1:h1|gamma");
			// a section appears before b section (request order preserved)
			expect(text.indexOf("a.txt")).toBeLessThan(text.indexOf("b.txt"));
			expect(calls).toBe(2);
			const value = (result as any).details.readseekValue;
			expect(value.summary).toEqual({ files: 2, lines: 4, errors: 0 });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("respects per-file offset and limit", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-many-"));
		try {
			const f = path.join(cwd, "f.txt");
			await writeFile(f, "one\ntwo\nthree\nfour\nfive\n", "utf8");
			mockReadForFile(f, ["one", "two", "three", "four", "five"]);

			const result = await executeReadMany({
				toolCallId: "t",
				params: { files: [{ path: "f.txt", offset: 2, limit: 2 }] },
				signal: undefined,
				onUpdate: undefined,
				cwd,
			});

			const text = textOf(result);
			expect(text).toContain("--- f.txt (lines 2-3 of 5) ---");
			expect(text).toContain("2:h2|two");
			expect(text).toContain("3:h3|three");
			expect(text).not.toContain("h1|one");
			expect(text).not.toContain("h4|four");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("continues past a missing file by default and reports the error inline", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-many-"));
		try {
			const good = path.join(cwd, "good.txt");
			await writeFile(good, "ok\n", "utf8");
			mockReadForFile(good, ["ok"]);

			const result = await executeReadMany({
				toolCallId: "t",
				params: { files: [{ path: "good.txt" }, { path: "missing.txt" }] },
				signal: undefined,
				onUpdate: undefined,
				cwd,
			});

			const text = textOf(result);
			expect(text).toContain("1:h1|ok");
			expect(text).toContain("--- missing.txt ---");
			expect(text).toContain("[Error:");
			expect((result as any).details.readseekValue.summary.errors).toBe(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("stops at first error when stopOnError is true", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-many-"));
		try {
			const good = path.join(cwd, "good.txt");
			await writeFile(good, "ok\n", "utf8");
			mockReadForFile(good, ["ok"]);

			const result = await executeReadMany({
				toolCallId: "t",
				params: { files: [{ path: "missing.txt" }, { path: "good.txt" }], stopOnError: true },
				signal: undefined,
				onUpdate: undefined,
				cwd,
			});

			const value = (result as any).details.readseekValue;
			// stopped before reading good.txt
			expect(value.files).toHaveLength(1);
			expect(value.files[0].ok).toBe(false);
			expect(readseekReadMock).not.toHaveBeenCalled();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("marks successfully read text files as anchored via onSuccessfulRead", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-many-"));
		try {
			const f = path.join(cwd, "anchored.txt");
			await writeFile(f, "x\n", "utf8");
			mockReadForFile(f, ["x"]);
			const onSuccessfulRead = vi.fn();

			await executeReadMany({
				toolCallId: "t",
				params: { files: [{ path: "anchored.txt" }, { path: "nope.txt" }] },
				signal: undefined,
				onUpdate: undefined,
				cwd,
				onSuccessfulRead,
			});

			expect(onSuccessfulRead).toHaveBeenCalledTimes(1);
			expect(onSuccessfulRead).toHaveBeenCalledWith(f);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects an empty files array", async () => {
		const result = await executeReadMany({
			toolCallId: "t",
			params: { files: [] },
			signal: undefined,
			onUpdate: undefined,
			cwd: ".",
		});
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(textOf(result)).toContain("non-empty");
	});

	it("reports an offset past end of file as a per-file error", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-many-"));
		try {
			const f = path.join(cwd, "small.txt");
			await writeFile(f, "only\n", "utf8");
			mockReadForFile(f, ["only"]);

			const result = await executeReadMany({
				toolCallId: "t",
				params: { files: [{ path: "small.txt", offset: 99 }] },
				signal: undefined,
				onUpdate: undefined,
				cwd,
			});

			const text = textOf(result);
			expect(text).toContain("[Error:");
			expect(text).toContain("past end of file");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("read_many packing logic", () => {
	/** Build a synthetic text RenderedBlock of a given size for packing tests. */
	function textBlock(index: number, lines: number, bytesPerLine = 80): any {
		const byteCount = lines * bytesPerLine + 40; // header overhead
		return {
			result: { kind: "text", index, rawPath: `f${index}.txt`, absolutePath: `/f${index}.txt`, lines: [], startLine: 1, endLine: lines, totalLines: lines, warnings: [] },
			text: "x".repeat(byteCount),
			lineCount: lines + 1,
			byteCount,
		};
	}

	it("greedyPack keeps files in order until the budget is exhausted", () => {
		const blocks = [textBlock(0, 10), textBlock(1, 10), textBlock(2, 10)];
		const selected = greedyPack(blocks, { maxLines: 25, maxBytes: 100_000 });
		// 10+1=11 lines each; two fit (22 <= 25), third would push to 33.
		expect([...selected]).toEqual([0, 1]);
	});

	it("selectTextBlocksAdaptive defaults to strict request order", () => {
		const blocks = [textBlock(0, 10), textBlock(1, 10), textBlock(2, 10)];
		const selected = selectTextBlocksAdaptive(blocks, { maxLines: 25, maxBytes: 100_000 });
		expect([...selected]).toEqual([0, 1]);
	});

	it("selectTextBlocksAdaptive switches to smallest-first when it fits more complete files", () => {
		// Large file first: strict order keeps only the large one (1 file),
		// while smallest-first keeps the two small ones (2 files).
		const blocks = [textBlock(0, 100), textBlock(1, 1), textBlock(2, 1)];
		const selected = selectTextBlocksAdaptive(blocks, { maxLines: 50, maxBytes: 100_000 });
		// Two small files selected (indices 1 and 2), large file (index 0) omitted.
		expect([...selected].sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("selectTextBlocksAdaptive omits a file that cannot fit on its own", () => {
		const blocks = [textBlock(0, 100), textBlock(1, 1)];
		const selected = selectTextBlocksAdaptive(blocks, { maxLines: 50, maxBytes: 100_000 });
		expect(selected.has(1)).toBe(true);
		expect(selected.has(0)).toBe(false);
	});
});