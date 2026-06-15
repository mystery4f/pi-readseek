import { stat } from "node:fs/promises";
import type { FileMap } from "./readseek/types.js";
import { generateMap, generateMapWithIdentity, READSEEK_MAPPER_IDENTITY } from "./readseek/mapper.js";
import {
  computeKey,
  contentHashFor64k,
  readCached,
  writeCached,
  persistenceEnabled,
} from "./persistent-map-cache.js";
interface CacheEntry {
	mtimeMs: number;
	contentHash: string;
	map: FileMap | null;
}
export const MAP_CACHE_MAX_SIZE = 500;

interface MapCacheGlobalState {
	cache: Map<string, CacheEntry>;
	maxSize: number;
}

const MAP_CACHE_STATE_KEY = Symbol.for("pi-readseek.mapCacheState.v1");

function getMapCacheState(): MapCacheGlobalState {
	const globalObject = globalThis as any;
	globalObject[MAP_CACHE_STATE_KEY] ??= {
		cache: new Map<string, CacheEntry>(),
		maxSize: MAP_CACHE_MAX_SIZE,
	} satisfies MapCacheGlobalState;
	return globalObject[MAP_CACHE_STATE_KEY] as MapCacheGlobalState;
}

function rememberInMemory(absPath: string, entry: CacheEntry): void {
	const state = getMapCacheState();
	if (state.cache.has(absPath)) state.cache.delete(absPath);
	state.cache.set(absPath, entry);
	if (state.cache.size > state.maxSize) {
		const oldestKey = state.cache.keys().next().value;
		if (oldestKey !== undefined) state.cache.delete(oldestKey);
	}
}

async function stableContentHash(
	absPath: string,
	mtimeMs: number,
	expectedHash: string,
): Promise<string | null> {
	if (!expectedHash) return null;
	const currentStat = await stat(absPath);
	if (currentStat.mtimeMs !== mtimeMs) return null;
	const currentHash = await contentHashFor64k(absPath);
	if (!currentHash || currentHash !== expectedHash) return null;
	return currentHash;
}

/**
 * Get or generate a structural file map, with mtime-based caching.
 * Returns null on any failure — never throws.
 */
export async function getOrGenerateMap(absPath: string): Promise<FileMap | null> {
	try {
		const fileStat = await stat(absPath);
		const { mtimeMs } = fileStat;
		const state = getMapCacheState();
		const cached = state.cache.get(absPath);
		if (cached && cached.mtimeMs === mtimeMs) {
			const currentHash = await contentHashFor64k(absPath);
			if (currentHash && currentHash === cached.contentHash) {
				state.cache.delete(absPath);
				state.cache.set(absPath, cached);
				return cached.map;
			}
		}
		if (!persistenceEnabled()) {
			const map = await generateMap(absPath);
			const hash = await contentHashFor64k(absPath);
			rememberInMemory(absPath, { mtimeMs, contentHash: hash, map });
			return map;
		}

		let preContentHash = "";
		try {
			preContentHash = await contentHashFor64k(absPath);
			if (preContentHash) {
				const key = computeKey(
					absPath,
					mtimeMs,
					preContentHash,
					READSEEK_MAPPER_IDENTITY.mapperName,
					READSEEK_MAPPER_IDENTITY.mapperVersion,
				);
				const fromDisk = await readCached(key);
				if (fromDisk) {
					rememberInMemory(absPath, { mtimeMs, contentHash: preContentHash, map: fromDisk });
					return fromDisk;
				}
			}
		} catch {
			// fall through to regeneration on a disk-cache miss
		}
		const { map, mapperName, mapperVersion } = await generateMapWithIdentity(absPath);
		const persistentIdentity = { mapperName, mapperVersion };
		let stableHash: string | null = null;
		let shouldRemember = true;
		if (preContentHash) {
			try {
				stableHash = await stableContentHash(absPath, mtimeMs, preContentHash);
				shouldRemember = stableHash !== null;
			} catch {
				shouldRemember = false;
			}
		}
		if (shouldRemember) {
			const hash = stableHash ?? preContentHash ?? "";
			rememberInMemory(absPath, { mtimeMs, contentHash: hash, map });
		}
		if (map && stableHash) {
			try {
				const key = computeKey(
					absPath,
					mtimeMs,
					stableHash,
					persistentIdentity.mapperName,
					persistentIdentity.mapperVersion,
				);
				await writeCached(key, map);
			} catch {
				// never fail the caller on a cache-write miss
			}
		}
		return map;
	} catch {
		return null;
	}
}