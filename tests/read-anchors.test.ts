import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createReadToolExecuteMock, readseekMapMock, readseekReadMock } = vi.hoisted(() => ({
	createReadToolExecuteMock: vi.fn(),
	readseekMapMock: vi.fn(),
	readseekReadMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		createReadTool: () => ({ execute: createReadToolExecuteMock }),
	};
});

vi.mock("../src/readseek-client.js", () => ({
	readseekMap: readseekMapMock,
	readseekRead: readseekReadMock,
}));

const { executeRead } = await import("../src/read.js");

describe("executeRead anchor tracking", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("marks text reads with readseek lines as anchored", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-read-"));
		try {
			const filePath = path.join(cwd, "file.txt");
			await writeFile(filePath, "hello\nworld\n", "utf8");
			readseekReadMock.mockResolvedValueOnce({
				file: filePath,
				language: "Text",
				line_count: 2,
				file_hash: "filehash",
				start_line: 1,
				end_line: 2,
				hashlines: [
					{ line: 1, hash: "aaa", text: "hello" },
					{ line: 2, hash: "bbb", text: "world" },
				],
			});
			const onSuccessfulRead = vi.fn();

			await executeRead({
				toolCallId: "test",
				params: { path: "file.txt" },
				signal: undefined,
				onUpdate: undefined,
				cwd,
				onSuccessfulRead,
			});

			expect(onSuccessfulRead).toHaveBeenCalledWith(filePath);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("does not mark delegated image reads as anchored", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-read-"));
		try {
			createReadToolExecuteMock.mockResolvedValueOnce({
				content: [{ type: "text", text: "image attachment" }],
			});
			const onSuccessfulRead = vi.fn();

			await executeRead({
				toolCallId: "test",
				params: { path: "image.png" },
				signal: undefined,
				onUpdate: undefined,
				cwd,
				onSuccessfulRead,
			});

			expect(onSuccessfulRead).not.toHaveBeenCalled();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it.each(["map", "local"])("treats %s bundle without symbol as a map read", async (bundle) => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-read-"));
		try {
			const filePath = path.join(cwd, "file.ts");
			await writeFile(filePath, "const value = 1;\n", "utf8");
			readseekReadMock.mockResolvedValueOnce({
				file: filePath,
				language: "TypeScript",
				line_count: 1,
				file_hash: "filehash",
				start_line: 1,
				end_line: 1,
				hashlines: [{ line: 1, hash: "aaa", text: "const value = 1;" }],
			});
			readseekMapMock.mockResolvedValueOnce({
				path: filePath,
				totalLines: 1,
				totalBytes: 17,
				language: "TypeScript",
				symbols: [],
				imports: [],
				detailLevel: "full",
			});

			const result = await executeRead({
				toolCallId: "test",
				params: { path: "file.ts", bundle },
				signal: undefined,
				onUpdate: undefined,
				cwd,
			});

			expect((result as { isError?: boolean }).isError).not.toBe(true);
			expect((result.details as any).readseekValue.map).toEqual({
				requested: true,
				appended: true,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
