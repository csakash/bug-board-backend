const cache = new Map();
export async function remember(key, ttlMs, compute) {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    const value = await compute();
    cache.set(key, { value, expiresAt: now + ttlMs });
    return value;
}
export function invalidateCache(prefix) {
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) {
            cache.delete(key);
        }
    }
}
//# sourceMappingURL=response-cache.js.map