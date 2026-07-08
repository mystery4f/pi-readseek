import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createReadToolExecuteMock, readseekMapMock, readseekReadMock, readseekDetectMock } = vi.hoisted(() => ({
	createReadToolExecuteMock: vi.fn(),
	readseekMapMock: vi.fn(),
	readseekReadMock: vi.fn(),
	readseekDetectMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => ({
	...(await import("./support/pi-coding-agent-mock.js")).createPiCodingAgentBaseMock(),
	createReadTool: () => ({ execute: createReadToolExecuteMock }),
}));

vi.mock("../src/readseek-client.js", () => ({
	readseekMap: readseekMapMock,
	readseekRead: readseekReadMock,
	readseekDetect: readseekDetectMock,
}));

const { executeRead } = await import("../src/read.js");

describe("executeRead anchor tracking", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	async function writeImage(cwd: string): Promise<string> {
		const filePath = path.join(cwd, "image.png");
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			"base64",
		);
		await writeFile(filePath, png);
		return filePath;
	}

	function mockImageDetection(filePath: string) {
		const imageDetection = {
			kind: "image",
			type: "image/png",
			file: filePath,
			mime: "image/png",
			format: "png",
			width: 1,
			height: 1,
			animated: false,
		};
		readseekDetectMock.mockImplementation((_filePath: string, options?: { transcribe?: boolean; caption?: boolean; objects?: boolean }) =>
			Promise.resolve(
				options?.transcribe || options?.caption || options?.objects
					? {
							...imageDetection,
							...(options.transcribe ? { transcribe: { text: "OCR TEXT", regions: [{ text: "OCR TEXT", quad: [0, 0, 1, 0, 1, 1, 0, 1] }] } } : {}),
							...(options.caption ? { caption: "A tiny test image." } : {}),
							...(options.objects ? { objects: [{ label: "dot", bbox: [1, 2, 3, 4] }] } : {}),
						}
					: imageDetection,
			),
		);
	}

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

	it("falls back to image attachment when OCR detect crashes", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-read-"));
		try {
			const filePath = await writeImage(cwd);
			const imageDetection = {
				kind: "image",
				type: "image/png",
				file: filePath,
				mime: "image/png",
				format: "png",
				width: 1,
				height: 1,
				animated: false,
			};
readseekDetectMock
				.mockRejectedValueOnce(new Error("readseek crashed with SIGFPE"));
			createReadToolExecuteMock.mockResolvedValueOnce({
				content: [{ type: "text", text: "image attachment" }],
			});

			const result = await executeRead({
				toolCallId: "test",
				params: { path: "image.png" },
				signal: undefined,
				onUpdate: undefined,
				cwd,
			});

			const text = (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
			expect(text).toContain("image attachment");
			expect(text).toContain("(OCR) unavailable");
			expect(text).not.toContain("binary");
			const details = (result as any).details;
			expect(details?.readseekValue).toBeUndefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("appends OCR text to image reads and does not mark them as anchored", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-read-"));
		try {
			const filePath = await writeImage(cwd);
			mockImageDetection(filePath);
			createReadToolExecuteMock.mockResolvedValueOnce({
				content: [{ type: "text", text: "image attachment" }],
			});
			const onSuccessfulRead = vi.fn();

			const result = await executeRead({
				toolCallId: "test",
				params: { path: "image.png" },
				signal: undefined,
				onUpdate: undefined,
				cwd,
				onSuccessfulRead,
			});

			expect(onSuccessfulRead).not.toHaveBeenCalled();
			const text = (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
			expect(text).toContain("image attachment");
			expect(text).toContain("OCR TEXT");
			expect(text).toContain("Image caption:\nA tiny test image.");
			expect(text).toContain("Detected objects:\n- dot [1, 2, 3, 4]");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("skips OCR when ocrMode is off", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-read-"));
		try {
			vi.stubEnv("READSEEK_READ_OCR_MODE", "off");
			const filePath = await writeImage(cwd);
			mockImageDetection(filePath);
			createReadToolExecuteMock.mockResolvedValueOnce({
				content: [{ type: "text", text: "image attachment" }],
			});

			const result = await executeRead({
				toolCallId: "test",
				params: { path: "image.png" },
				signal: undefined,
				onUpdate: undefined,
				cwd,
				modelSupportsImages: false,
			});

			const text = (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
			expect(text).toBe("image attachment");
			expect(readseekDetectMock).toHaveBeenCalledTimes(0);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("skips OCR for image-capable models when ocrMode is auto", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-read-"));
		try {
			vi.stubEnv("READSEEK_READ_OCR_MODE", "auto");
			const filePath = await writeImage(cwd);
			mockImageDetection(filePath);
			createReadToolExecuteMock.mockResolvedValueOnce({
				content: [{ type: "text", text: "image attachment" }],
			});

			const result = await executeRead({
				toolCallId: "test",
				params: { path: "image.png" },
				signal: undefined,
				onUpdate: undefined,
				cwd,
				modelSupportsImages: true,
			});

			const text = (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
			expect(text).toBe("image attachment");
			expect(readseekDetectMock).toHaveBeenCalledTimes(0);
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
