import { describe, expect, it } from "vitest";

import { coerceObviousBase10Int } from "../src/coerce-obvious-int.js";

describe("coerceObviousBase10Int", () => {
	it("accepts the largest safe integer", () => {
		expect(coerceObviousBase10Int(String(Number.MAX_SAFE_INTEGER), "limit")).toEqual({
			ok: true,
			value: Number.MAX_SAFE_INTEGER,
		});
	});

	it("rejects unsafe string integers", () => {
		const result = coerceObviousBase10Int("9007199254740992", "limit");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("safe base-10 integer");
		}
	});

	it("rejects unsafe numeric integers", () => {
		const result = coerceObviousBase10Int(Number.MAX_SAFE_INTEGER + 1, "limit");

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("safe base-10 integer");
		}
	});
});
