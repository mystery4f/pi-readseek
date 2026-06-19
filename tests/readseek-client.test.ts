import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, homeDir } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	homeDir: { value: "" },
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		homedir: () => homeDir.value,
	};
});

const { readseekRead, readseekSearch } = await import("../src/readseek-client.js");

function spawnResult(stdout: string) {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn();
	queueMicrotask(() => {
		child.stdout.end(stdout);
		child.stderr.end();
		child.emit("close", 0);
	});
	return child;
}

describe("readseek client parsing", () => {
	let previousReadseekBin: string | undefined;
	let tempHome: string;

	beforeEach(async () => {
		previousReadseekBin = process.env.READSEEK_BIN;
		process.env.READSEEK_BIN = "/bin/readseek";
		tempHome = await mkdtemp(path.join(tmpdir(), "pi-readseek-home-"));
		homeDir.value = tempHome;
		spawnMock.mockReset();
	});

	afterEach(async () => {
		if (previousReadseekBin === undefined) delete process.env.READSEEK_BIN;
		else process.env.READSEEK_BIN = previousReadseekBin;
		await rm(tempHome, { recursive: true, force: true });
	});

	it("uses readseek 0.4 start flag for ranged reads", async () => {
		const validReadOutput = JSON.stringify({
			file: "/tmp/file.txt",
			language: "Text",
			line_count: 5,
			file_hash: "hash",
			start_line: 2,
			end_line: 4,
			hashlines: [{ line: 2, hash: "abc", text: "hello" }],
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(validReadOutput));

		await readseekRead("/tmp/file.txt", 2, 4);

		expect(spawnMock).toHaveBeenLastCalledWith(
			"/bin/readseek",
			["read", "/tmp/file.txt", "--start", "2", "--end", "4"],
			expect.any(Object),
		);
	});

	it("accepts readseek 0.4 search matches without pattern_index", async () => {
		const searchOutput = JSON.stringify({
			results: [
				{
					file: "/tmp/file.rs",
					language: "rust",
					file_hash: "hash",
					matches: [
						{
							start_line: 1,
							end_line: 1,
							start_hash: "abc",
							end_hash: "abc",
							hashlines: [{ line: 1, hash: "abc", text: "fn main() {}" }],
							captures: [],
						},
					],
				},
			],
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(searchOutput));

		const results = await readseekSearch("/tmp/file.rs", "fn $NAME() {}");

		expect(results[0]?.matches[0]?.pattern_index).toBe(0);
	});

	it("rejects non-integer numeric fields from readseek JSON", async () => {
		const invalidReadOutput = JSON.stringify({
			file: "/tmp/file.txt",
			language: "Text",
			line_count: 1,
			file_hash: "hash",
			start_line: 1,
			end_line: 1,
			hashlines: [{ line: 1.5, hash: "abc", text: "hello" }],
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(invalidReadOutput));

		await expect(readseekRead("/tmp/file.txt")).rejects.toThrow(
			"invalid readseek hashline.line: expected safe integer",
		);
	});

	it("rejects unsafe numeric fields from readseek JSON", async () => {
		const invalidReadOutput = JSON.stringify({
			file: "/tmp/file.txt",
			language: "Text",
			line_count: 9007199254740992,
			file_hash: "hash",
			start_line: 1,
			end_line: 1,
			hashlines: [{ line: 1, hash: "abc", text: "hello" }],
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(invalidReadOutput));

		await expect(readseekRead("/tmp/file.txt")).rejects.toThrow(
			"invalid readseek line_count: expected safe integer",
		);
	});
});
