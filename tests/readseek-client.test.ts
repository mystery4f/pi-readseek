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

const { readseekRead, readseekSearch, readseekDetect } = await import("../src/readseek-client.js");

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

function spawnSignalCrash(signal: NodeJS.Signals) {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn();
	queueMicrotask(() => {
		child.stdout.end();
		child.stderr.end();
		child.emit("close", null, signal);
	});
	return child;
}

describe("readseek client parsing", () => {
	let previousReadSeekBin: string | undefined;
	let tempHome: string;

	beforeEach(async () => {
		previousReadSeekBin = process.env.READSEEK_BIN;
		process.env.READSEEK_BIN = "/bin/readseek";
		tempHome = await mkdtemp(path.join(tmpdir(), "pi-readseek-home-"));
		homeDir.value = tempHome;
		spawnMock.mockReset();
	});

	afterEach(async () => {
		if (previousReadSeekBin === undefined) delete process.env.READSEEK_BIN;
		else process.env.READSEEK_BIN = previousReadSeekBin;
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

	it("reports readseek signal crashes by signal name", async () => {
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnSignalCrash("SIGFPE"));

		await expect(readseekRead("/tmp/file.txt")).rejects.toThrow("readseek killed by signal SIGFPE");
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

	it("classifies image detections by structural fields", async () => {
		const imageOutput = JSON.stringify({
			type: "image/png",
			file: "/tmp/image.png",
			mime: "image/png",
			format: "png",
			width: 1,
			height: 1,
			animated: false,
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(imageOutput));

		const detection = await readseekDetect("/tmp/image.png");

		expect(detection.kind).toBe("image");
		expect(detection.type).toBe("image/png");
		if (detection.kind === "image") expect(detection.transcribe).toBeUndefined();
	});

	it("parses image captions and objects from requested detections", async () => {
		const imageOutput = JSON.stringify({
			type: "image/png",
			file: "/tmp/image.png",
			mime: "image/png",
			format: "png",
			width: 10,
			height: 20,
			animated: false,
			caption: "A tiny test image.",
			objects: [{ label: "dot", bbox: [1, 2, 3, 4] }],
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(imageOutput));

		const detection = await readseekDetect("/tmp/image.png", { caption: true, objects: true });

		expect(spawnMock).toHaveBeenLastCalledWith(
			"/bin/readseek",
			["detect", "--caption", "--objects", "/tmp/image.png"],
			expect.any(Object),
		);
		expect(detection.kind).toBe("image");
		if (detection.kind === "image") {
			expect(detection.caption).toBe("A tiny test image.");
			expect(detection.objects).toEqual([{ label: "dot", bbox: [1, 2, 3, 4] }]);
		}
	});

	it("rejects invalid image object bounding boxes", async () => {
		const imageOutput = JSON.stringify({
			type: "image/png",
			file: "/tmp/image.png",
			format: "png",
			width: 10,
			height: 20,
			animated: false,
			objects: [{ label: "dot", bbox: [1, 2, 3] }],
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(imageOutput));

		await expect(readseekDetect("/tmp/image.png", { objects: true })).rejects.toThrow(
			"invalid readseek detect object.bbox",
		);
	});

	it("classifies source detections by language field", async () => {
		const sourceOutput = JSON.stringify({
			type: "text/plain",
			file: "/tmp/sample.rs",
			language: "rust",
			engine: "tree-sitter",
			supported: true,
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(sourceOutput));

		const detection = await readseekDetect("/tmp/sample.rs");

		expect(detection.kind).toBe("source");
		if (detection.kind === "source") expect(detection.language).toBe("rust");
	});

	it("classifies plain-text detections without language or format", async () => {
		const textOutput = JSON.stringify({
			type: "text/plain",
			file: "/tmp/note.txt",
		});
		spawnMock
			.mockImplementationOnce(() => spawnResult(""))
			.mockImplementationOnce(() => spawnResult(textOutput));

		const detection = await readseekDetect("/tmp/note.txt");

		expect(detection.kind).toBe("text");
		expect(detection.type).toBe("text/plain");
	});
});
