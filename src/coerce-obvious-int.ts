const BASE10_INT_RE = /^-?\d+$/;
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

type CoercedIntResult =
  | { ok: true; value: number | undefined }
  | { ok: false; message: string };

function formatReceived(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function invalidInteger(value: unknown, name: string): CoercedIntResult {
  return {
    ok: false,
    message: `Invalid ${name}: expected a safe base-10 integer, received ${formatReceived(value)}.`,
  };
}

export function coerceObviousBase10Int(value: unknown, name: string): CoercedIntResult {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      return { ok: true, value };
    }
    return invalidInteger(value, name);
  }

  if (typeof value === "string" && BASE10_INT_RE.test(value)) {
    const parsed = BigInt(value);
    if (parsed >= MIN_SAFE_INTEGER && parsed <= MAX_SAFE_INTEGER) {
      return { ok: true, value: Number(parsed) };
    }
  }

  return invalidInteger(value, name);
}
