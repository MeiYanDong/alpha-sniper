import { createWalletClient, formatEther, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import {
  clAlphaHookAbi,
  erc20Abi,
  infinityCLPoolManagerAbi,
  permit2Abi,
  universalRouterAbi
} from "./abis.js";
import { loadConfigFromArgs, sameAddress } from "./config.js";
import { applySlippageBps, buildInfinityExactInputSingleExecute } from "./infinity-swap.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";
import {
  createBscClient,
  getTokenMeta,
  quoteInfinityCLExactInputSingle,
  summarizeContractError
} from "./pools.js";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function loadAccount() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env.local");
  return privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
}

async function readAllowanceState({ client, owner, token, permit2, router }) {
  const [erc20Allowance, permit2Allowance] = await Promise.all([
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, permit2]
    }),
    client.readContract({
      address: permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [owner, token, router]
    })
  ]);
  const [permit2Amount, permit2Expiration] = permit2Allowance;
  return {
    erc20Allowance,
    permit2Amount,
    permit2Expired:
      Number(permit2Expiration) === 0 ||
      Number(permit2Expiration) <= Math.floor(Date.now() / 1000)
  };
}

async function main() {
  const config = loadConfigFromArgs();
  const direction = argValue("--direction", "buy");
  if (!["buy", "sell"].includes(direction)) {
    throw new Error("--direction must be buy or sell");
  }

  const account = loadAccount();
  const configuredWallet = process.env.WALLET_ADDRESS;
  if (configuredWallet && !sameAddress(account.address, configuredWallet)) {
    throw new Error("PRIVATE_KEY does not match WALLET_ADDRESS");
  }

  const client = createBscClient(config.rpcUrls);
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(config.rpcUrl, { timeout: 25_000 })
  });

  const [targetMeta, quoteMeta, poolKey] = await Promise.all([
    getTokenMeta(client, config.targetToken),
    getTokenMeta(client, config.quoteToken),
    client.readContract({
      address: config.addresses.infinityCLPoolManager,
      abi: infinityCLPoolManagerAbi,
      functionName: "poolIdToPoolKey",
      args: [config.protocols.infinityCL.poolId]
    })
  ]);
  const hookStarted = await client.readContract({
    address: poolKey[2],
    abi: clAlphaHookAbi,
    functionName: "isPoolStarted",
    args: [config.protocols.infinityCL.poolId]
  });

  const inputToken = direction === "buy" ? config.quoteToken : config.targetToken;
  const outputToken = direction === "buy" ? config.targetToken : config.quoteToken;
  const inputMeta = direction === "buy" ? quoteMeta : targetMeta;
  const outputMeta = direction === "buy" ? targetMeta : quoteMeta;
  const [inputBalanceBefore, outputBalanceBefore] = await Promise.all([
    client.readContract({
      address: inputToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.readContract({
      address: outputToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    })
  ]);
  const amountArg = argValue("--amount-in");
  const amountIn =
    amountArg !== undefined
      ? parseUnits(amountArg, inputMeta.decimals)
      : inputBalanceBefore;

  const zeroForOne = sameAddress(poolKey[0], inputToken);
  const slippageBps = Number(argValue("--slippage-bps", config.exit?.maxSlippageBps || config.execution?.maxSlippageBps || 500));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(argValue("--deadline-seconds", "60")));

  console.log(`${config.name} ${direction.toUpperCase()} exact-input`);
  console.log(`Wallet: ${account.address}`);
  console.log(`Trading started: ${Boolean(hookStarted)}`);
  console.log(`Input balance before: ${fmtDecimal(toDecimalAmount(inputBalanceBefore, inputMeta.decimals), 8)} ${inputMeta.symbol}`);
  console.log(`Output balance before: ${fmtDecimal(toDecimalAmount(outputBalanceBefore, outputMeta.decimals), 8)} ${outputMeta.symbol}`);
  console.log(`Amount in: ${fmtDecimal(toDecimalAmount(amountIn, inputMeta.decimals), 8)} ${inputMeta.symbol}`);

  if (amountIn === 0n) throw new Error("Amount in is zero");
  if (inputBalanceBefore < amountIn) throw new Error("Input token balance is too low");
  if (!hookStarted) throw new Error("Pool hook is not started");

  let quoteLatencyMs = 0;
  const [quoteResult, allowance] = await Promise.all([
    (async () => {
      const quoteStart = performance.now();
      const result = await quoteInfinityCLExactInputSingle({
        client,
        quoter: config.addresses.infinityCLQuoter,
        poolKey,
        zeroForOne,
        exactAmount: amountIn
      });
      quoteLatencyMs = performance.now() - quoteStart;
      return result;
    })(),
    readAllowanceState({
      client,
      owner: account.address,
      token: inputToken,
      permit2: config.addresses.permit2,
      router: config.addresses.infinityUniversalRouter
    })
  ]);
  const [amountOut, quoteGas] = quoteResult;
  const minOut = applySlippageBps(amountOut, slippageBps);

  console.log(
    `Quote: ${fmtDecimal(toDecimalAmount(amountOut, outputMeta.decimals), 8)} ${outputMeta.symbol}, minOut ${fmtDecimal(toDecimalAmount(minOut, outputMeta.decimals), 8)} ${outputMeta.symbol}, quoterGas ${quoteGas.toString()}, latency ${quoteLatencyMs.toFixed(0)}ms`
  );

  const approvalsOk =
    allowance.erc20Allowance >= amountIn &&
    allowance.permit2Amount >= amountIn &&
    !allowance.permit2Expired;
  if (!approvalsOk) {
    console.log(`ERC20 allowance to Permit2: ${fmtDecimal(toDecimalAmount(allowance.erc20Allowance, inputMeta.decimals), 8)} ${inputMeta.symbol}`);
    console.log(`Permit2 allowance to router: ${fmtDecimal(toDecimalAmount(allowance.permit2Amount, inputMeta.decimals), 8)} ${inputMeta.symbol}${allowance.permit2Expired ? " (expired/missing)" : ""}`);
    throw new Error("Approval missing for input token");
  }

  const tx = buildInfinityExactInputSingleExecute({
    poolKey,
    zeroForOne,
    amountIn,
    amountOutMinimum: minOut,
    inputCurrency: inputToken,
    outputCurrency: outputToken,
    deadline
  });

  let gas;
  let gasPrice;
  let bnbBefore;
  try {
    [gas, gasPrice, bnbBefore] = await Promise.all([
      client.estimateContractGas({
        account,
        address: config.addresses.infinityUniversalRouter,
        abi: universalRouterAbi,
        functionName: "execute",
        args: [tx.commands, tx.inputs, tx.deadline]
      }),
      client.getGasPrice(),
      client.getBalance({ address: account.address })
    ]);
  } catch (error) {
    const summary = summarizeContractError(error);
    console.log(`Simulation failed: ${summary.shortMessage}`);
    throw error;
  }

  const gasBufferBps = BigInt(argValue("--gas-buffer-bps", "12000"));
  const gasPriceMultiplierBps = BigInt(argValue("--gas-price-multiplier-bps", "12000"));
  const bufferedGas = (gas * gasBufferBps) / 10_000n;
  const boostedGasPrice = (gasPrice * gasPriceMultiplierBps) / 10_000n;
  const estimatedGasCost = bufferedGas * boostedGasPrice;
  if (bnbBefore < estimatedGasCost) {
    throw new Error(
      `BNB balance is below boosted gas budget: have ${formatEther(bnbBefore)}, need ${formatEther(estimatedGasCost)}`
    );
  }
  console.log(`Simulation: ok, gas ${gas.toString()}, bufferedGas ${bufferedGas.toString()}, estimated cost ${formatEther(estimatedGasCost)} BNB`);

  if (!hasFlag("--send")) {
    console.log("Mode: DRY_RUN. Re-run with --send only after explicit approval.");
    return;
  }

  const hash = await walletClient.writeContract({
    address: config.addresses.infinityUniversalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [tx.commands, tx.inputs, tx.deadline],
    gas: bufferedGas,
    gasPrice: boostedGasPrice
  });
  console.log(`Swap tx sent: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`Swap tx status: ${receipt.status}`);

  const [inputBalanceAfter, outputBalanceAfter, bnbAfter] = await Promise.all([
    client.readContract({
      address: inputToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.readContract({
      address: outputToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.getBalance({ address: account.address })
  ]);
  console.log(`Input balance after: ${fmtDecimal(toDecimalAmount(inputBalanceAfter, inputMeta.decimals), 8)} ${inputMeta.symbol}`);
  console.log(`Output balance after: ${fmtDecimal(toDecimalAmount(outputBalanceAfter, outputMeta.decimals), 8)} ${outputMeta.symbol}`);
  console.log(`BNB after: ${formatEther(bnbAfter)}`);
}

main().catch((error) => {
  console.error(error.shortMessage || error.message || error);
  process.exitCode = 1;
});
