import fs from "node:fs";
import path from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(config) {
  const name = String(config.name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return path.resolve(process.cwd(), "data/cache", `${name || "project"}-static.json`);
}

function serialize(value) {
  return JSON.stringify(value, (_key, current) => (typeof current === "bigint" ? current.toString() : current), 2);
}

function cacheScope(config) {
  return {
    chainId: config.chainId,
    targetToken: String(config.targetToken).toLowerCase(),
    quoteToken: String(config.quoteToken).toLowerCase(),
    poolId: String(config.protocols?.infinityCL?.poolId || "").toLowerCase()
  };
}

function sameScope(a, b) {
  return (
    a?.chainId === b?.chainId &&
    a?.targetToken === b?.targetToken &&
    a?.quoteToken === b?.quoteToken &&
    a?.poolId === b?.poolId
  );
}

export function createProjectCache(config, { enabled = true, ttlMs = DEFAULT_TTL_MS } = {}) {
  const file = cachePath(config);
  const scope = cacheScope(config);

  function read() {
    if (!enabled || !fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!sameScope(parsed.scope, scope)) return null;
      if (Date.now() - Number(parsed.updatedAtMs || 0) > ttlMs) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function write(nextData) {
    if (!enabled) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = read() || {};
    const merged = {
      ...current,
      ...nextData,
      tokenMeta: {
        ...(current.tokenMeta || {}),
        ...(nextData.tokenMeta || {})
      }
    };
    fs.writeFileSync(
      file,
      `${serialize({ ...merged, scope, updatedAtMs: Date.now() })}\n`
    );
  }

  return { enabled, file, read, write };
}

function normalizeTokenMeta(meta) {
  return {
    address: meta.address,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    totalSupply: meta.totalSupply?.toString?.() || "0"
  };
}

function hydrateTokenMeta(meta) {
  if (!meta) return null;
  return { ...meta, totalSupply: BigInt(meta.totalSupply || "0") };
}

export async function getCachedTokenMeta({ cache, address, load }) {
  const lower = String(address).toLowerCase();
  const current = cache.read();
  const cached = current?.tokenMeta?.[lower];
  if (cached) return hydrateTokenMeta(cached);

  const meta = await load();
  const next = current || {};
  next.tokenMeta = { ...(next.tokenMeta || {}), [lower]: normalizeTokenMeta(meta) };
  cache.write(next);
  return meta;
}

export async function getCachedPoolKey({ cache, load }) {
  const current = cache.read();
  if (current?.poolKey) return current.poolKey;

  const poolKey = await load();
  cache.write({ ...(current || {}), poolKey });
  return poolKey;
}
