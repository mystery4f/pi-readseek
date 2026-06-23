import { stat } from "node:fs/promises";
import type { FileMap } from "./readseek/types.js";
import { readseekMap } from "./readseek-client.js";

interface CacheEntry {
	mtimeMs: number;
	map: FileMap | null;
}

export const MAP_CACHE_MAX_SIZE = 500;

interface MapCacheGlobalState {
	cache: Map<string, CacheEntry>;
	inflight: Map<string, Promise<FileMap | null>>;
	maxSize: number;
}

const MAP_CACHE_STATE_KEY = Symbol.for("pi-readseek.mapCacheState.v1");

type MapCacheGlobalSlots = typeof globalThis & Record<symbol, MapCacheGlobalState | undefined>;

function getMapCacheState(): MapCacheGlobalState {
	const globalObject = globalThis as MapCacheGlobalSlots;
	const state = globalObject[MAP_CACHE_STATE_KEY] ?? {
		cache: new Map<string, CacheEntry>(),
		inflight: new Map<string, Promise<FileMap | null>>(),
		maxSize: MAP_CACHE_MAX_SIZE,
	};
	globalObject[MAP_CACHE_STATE_KEY] = state;
	return state;
}
/** Move an existing entry to the most-recently-used position (Map insertion-order tail). */
function touchMapEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
	map.delete(key);
	map.set(key, value);
}

function rememberInMemory(absPath: string, entry: CacheEntry): void {
	const state = getMapCacheState();
	touchMapEntry(state.cache, absPath, entry);
	if (state.cache.size > state.maxSize) {
		const oldestKey = state.cache.keys().next().value;
		if (oldestKey !== undefined) state.cache.delete(oldestKey);
	}
}

/**
 * Get or generate a structural file map, with mtime-based in-memory caching.
 * Readseek already caches map results in `.readseek/maps/` with its own binary
 * format.  The in-memory layer here avoids redundant process spawns within a
 * single session.
 *
 * Returns null on any failure — never throws.
 */
export async function getOrGenerateMap(absPath: string): Promise<FileMap | null> {
	try {
		const fileStat = await stat(absPath);
		const { mtimeMs } = fileStat;
		const state = getMapCacheState();
		const cached = state.cache.get(absPath);
		if (cached && cached.mtimeMs === mtimeMs) {
			touchMapEntry(state.cache, absPath, cached);
			return cached.map;
		}
		const inflight = state.inflight.get(absPath);
		if (inflight) return inflight;

		const generation = (async () => {
			const map = await readseekMap(absPath, fileStat.size);
			rememberInMemory(absPath, { mtimeMs, map });
			return map;
		})()
			.catch(() => null)
			.finally(() => {
				state.inflight.delete(absPath);
			});
		state.inflight.set(absPath, generation);
		return generation;
	} catch {
		return null;
	}
}
