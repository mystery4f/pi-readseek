import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
	executeMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => ({
	...(await import("./support/pi-coding-agent-mock.js")).createPiCodingAgentBaseMock(),
	createGrepTool: () => ({ execute: executeMock }),
}));

const { executeGrep } = await import("../src/grep.js");

describe("executeGrep summary mode", () => {
	it("counts parsed matches without requiring source files for anchors", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-readseek-grep-"));
		try {
			executeMock.mockResolvedValueOnce({
				content: [
					{
						type: "text",
						text: "missing.ts:10: foo\nmissing.ts:20: foo\nother.ts:3: foo",
					},
				],
			});

			const result = await executeGrep({
				toolCallId: "test",
				params: { pattern: "foo", path: ".", summary: true },
				signal: undefined,
				onUpdate: undefined,
				cwd,
			});

			const textBlock = result.content.find(
				(item: { type: string; text?: string }) => item.type === "text",
			);

			expect(textBlock?.text).toContain("[3 matches in 2 files]");
			expect(textBlock?.text).toContain(`${path.join(cwd, "missing.ts")}: 2 matches`);
			expect(textBlock?.text).toContain(`${path.join(cwd, "other.ts")}: 1 matches`);
			expect(textBlock?.text).not.toContain(">>");
			expect(result.details.readseekValue).toEqual({
				tool: "grep",
				summary: true,
				totalMatches: 3,
				records: [],
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
