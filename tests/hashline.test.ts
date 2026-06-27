import { describe, expect, it } from "vitest";

import { parseLineRef } from "../src/hashline.js";

describe("parseLineRef", () => {
	it("rejects unsafe anchor line numbers", () => {
		expect(() => parseLineRef("9007199254740992:abc")).toThrow(/safe integer/);
	});

	it("strips the >> match marker from search/refs anchors", () => {
		expect(parseLineRef(">>78:f0e")).toMatchObject({ line: 78, hash: "f0e" });
	});

	it("strips the >>> mismatch-hint marker and keeps content", () => {
		expect(parseLineRef(">>> 41:b34|  const renamed = 3;")).toMatchObject({
			line: 41,
			hash: "b34",
			content: "  const renamed = 3;",
		});
	});

	it("strips leading indentation from context lines", () => {
		expect(parseLineRef("    78:f0e")).toMatchObject({ line: 78, hash: "f0e" });
	});

	it("still accepts a bare anchor", () => {
		expect(parseLineRef("78:f0e")).toMatchObject({ line: 78, hash: "f0e" });
	});
});
