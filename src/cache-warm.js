import { loadConfigFromArgs } from "./config.js";
import { infinityCLPoolManagerAbi } from "./abis.js";
import { createBscClient, getTokenMeta } from "./pools.js";
import { createProjectCache, getCachedPoolKey, getCachedTokenMeta } from "./project-cache.js";

async function main() {
  const config = loadConfigFromArgs();
  const client = createBscClient(config.rpcUrls);
  const cache = createProjectCache(config);

  const [targetMeta, quoteMeta, poolKey] = await Promise.all([
    getCachedTokenMeta({
      cache,
      address: config.targetToken,
      load: () => getTokenMeta(client, config.targetToken)
    }),
    getCachedTokenMeta({
      cache,
      address: config.quoteToken,
      load: () => getTokenMeta(client, config.quoteToken)
    }),
    getCachedPoolKey({
      cache,
      load: () =>
        client.readContract({
          address: config.addresses.infinityCLPoolManager,
          abi: infinityCLPoolManagerAbi,
          functionName: "poolIdToPoolKey",
          args: [config.protocols.infinityCL.poolId]
        })
    })
  ]);

  console.log(`Cache warm: ${cache.file}`);
  console.log(`- target: ${targetMeta.symbol} decimals=${targetMeta.decimals}`);
  console.log(`- quote: ${quoteMeta.symbol} decimals=${quoteMeta.decimals}`);
  console.log(`- pool hook: ${poolKey[2]}`);
}

main().catch((error) => {
  console.error(error.shortMessage || error.message || error);
  process.exitCode = 1;
});
