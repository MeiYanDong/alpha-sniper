export const PUBLIC_BSC_RPC_URL = "https://bsc-dataseed.binance.org";

function pushUnique(providers, provider) {
  if (!provider?.url) return;
  if (provider.skipPublic && provider.url === PUBLIC_BSC_RPC_URL) return;
  if (providers.some((item) => item.url === provider.url)) return;
  const { skipPublic, ...safeProvider } = provider;
  providers.push(safeProvider);
}

export function getSafeRpcProviders(config, { includePublic = true } = {}) {
  const providers = [];
  const skipPublic = !includePublic;

  pushUnique(providers, { label: "chainstack-primary", url: process.env.BSC_RPC_URL, skipPublic });
  pushUnique(providers, { label: "chainstack-alias", url: process.env.CHAINSTACK_BSC_RPC_URL, skipPublic });
  pushUnique(providers, { label: "ankr-bsc", url: process.env.ANKR_BSC_RPC_URL, skipPublic });
  if (includePublic) pushUnique(providers, { label: "public-bsc", url: PUBLIC_BSC_RPC_URL });

  for (const [index, url] of (config.rpcUrls || []).entries()) {
    pushUnique(providers, { label: `configured-${index + 1}`, url, skipPublic });
  }

  pushUnique(providers, { label: "config-fallback", url: config.defaultRpcUrl, skipPublic });

  return providers;
}

export function filterRpcProviders(providers, labelsCsv) {
  if (!labelsCsv) return providers;
  const wanted = new Set(
    String(labelsCsv)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return providers.filter((provider) => wanted.has(provider.label));
}

export function classifyRpcError(error) {
  const message = String(error?.message || error || "");
  if (error?.name === "AbortError") return "timeout";
  if (error?.status === 401 || error?.code === 401 || /unauthorized|forbidden|auth/i.test(message)) return "auth";
  if (error?.status === 429 || error?.code === 429 || /rate|quota|too many/i.test(message)) return "quota";
  if (/limit|exceed|capacity|throttle/i.test(message)) return "provider-limit";
  if (/execution reverted|revert|PoolNotStarted|Pool not started/i.test(message)) return "contract-revert";
  if (/invalid|rlp|decode|raw transaction|signed transaction|transaction type|unmarshal|insufficient funds|nonce too low|underpriced/i.test(message)) return "rejected";
  if (error?.status) return `http:${error.status}`;
  if (error?.code) return `rpc:${error.code}`;
  return "network";
}

export async function rawRpcCall(url, method, params = [], { timeoutMs = 20_000, id = 1 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) {
      const error = new Error(json.error?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = json.error?.code;
      throw error;
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}
