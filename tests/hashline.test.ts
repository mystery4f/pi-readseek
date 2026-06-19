import { describe, expect, it } from "vitest";

import { parseLineRef } from "../src/hashline.js";

describe("parseLineRef", () => {
	it("rejects unsafe anchor line numbers", () => {
		expect(() => parseLineRef("9007199254740992:abc")).toThrow(/safe integer/);
	});
});
