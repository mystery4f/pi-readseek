import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { classifyReadseekFailureMock, readseekRefsMock } = vi.hoisted(() => ({
	classifyReadseekFailureMock: vi.fn(),
	readseekRefsMock: vi.fn(),
}));

vi.mock("../src/readseek-client.js", () => ({
	classifyReadseekFailure: classifyReadseekFailureMock,
	readseekRefs: readseekRefsMock,
}));

vi.mock("../src/register-tool.js", () => ({
	registerReadseekTool: vi.fn(),
}));

vi.mock("@earendil-works/pi-tui", () => ({
	Text: class {},
}));

vi.mock("../src/tool-prompt-metadata.js", () => ({
	defineToolPromptMetadata: () => ({
		description: "refs",
		promptGuidelines: [],
		promptSnippet: "refs",
	}),
}));

const { executeRefs } = await import("../src/refs.js");

describe("executeRefs", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-refs-"));
		classifyReadseekFailureMock.mockImplementation((err: unknown) => ({
			code: "readseek-execution-error",
			message: String((err as { message?: unknown } | null)?.message || err),
		}));
		readseekRefsMock.mockReset();
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("maps scoped cursor validation failures to invalid parameters", async () => {
		await writeFile(path.join(cwd, "target.rs"), "fn main() {}\n", "utf8");
		readseekRefsMock.mockRejectedValueOnce(new Error("column 20 exceeds maximum column 13 for line 1"));

		const result = await executeRefs({
			params: { path: "target.rs", name: "main", scope: true, line: 1, column: 20 },
			signal: undefined,
			cwd,
		});

		expect(result.isError).toBe(true);
		expect(result.details.readseekValue.error).toEqual({
			code: "invalid-parameter",
			message: "column 20 exceeds maximum column 13 for line 1",
		});
	});

	it("keeps non-validation readseek failures as execution errors", async () => {
		await writeFile(path.join(cwd, "target.rs"), "fn main() {}\n", "utf8");
		readseekRefsMock.mockRejectedValueOnce(new Error("parser crashed"));

		const result = await executeRefs({
			params: { path: "target.rs", name: "main", scope: true, line: 1, column: 1 },
			signal: undefined,
			cwd,
		});

		expect(result.isError).toBe(true);
		expect(result.details.readseekValue.error).toEqual({
			code: "readseek-execution-error",
			message: "parser crashed",
		});
	});
});
