import { formatEther, maxUint256, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfigFromArgs, sameAddress } from "./config.js";
import { getExecutionConfig } from "./decision.js";
import { erc20Abi, permit2Abi } from "./abis.js";
import { createBscClient, getTokenMeta } from "./pools.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";

function loadAccount() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env.local");
  return privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
}

async function main() {
  const config = loadConfigFromArgs();
  const account = loadAccount();
  const configuredWallet = process.env.WALLET_ADDRESS;
  if (configuredWallet && !sameAddress(account.address, configuredWallet)) {
    throw new Error("PRIVATE_KEY does not match WALLET_ADDRESS");
  }

  const client = createBscClient(config.rpcUrls);
  const [quoteMeta, bnbBalance, gasPrice] = await Promise.all([
    getTokenMeta(client, config.quoteToken),
    client.getBalance({ address: account.address }),
    client.getGasPrice()
  ]);
  const execution = getExecutionConfig(config);
  const spendLimit = parseUnits(execution.maxSpendUsdt, quoteMeta.decimals);
  const [quoteBalance, erc20Permit2Allowance, internalPermit2Allowance] = await Promise.all([
    client.readContract({
      address: config.quoteToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    }),
    client.readContract({
      address: config.quoteToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, config.addresses.permit2]
    }),
    client.readContract({
      address: config.addresses.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [account.address, config.quoteToken, config.addresses.infinityUniversalRouter]
    })
  ]);
  const [internalPermit2Amount, internalPermit2Expiration] = internalPermit2Allowance;
  const internalPermit2Expired =
    Number(internalPermit2Expiration) === 0 ||
    Number(internalPermit2Expiration) <= Math.floor(Date.now() / 1000);

  console.log(`${config.name} execution readiness`);
  console.log(`Wallet: ${account.address}`);
  console.log(`BNB: ${formatEther(bnbBalance)}`);
  console.log(`${quoteMeta.symbol}: ${fmtDecimal(toDecimalAmount(quoteBalance, quoteMeta.decimals), 8)}`);
  console.log(`Max spend: ${fmtDecimal(toDecimalAmount(spendLimit, quoteMeta.decimals), 8)} ${quoteMeta.symbol}`);
  console.log("Auto buy tiers:");
  for (const tier of execution.autoBuyTiers) {
    const bounds = [
      tier.avgPriceGtUsd ? `> ${tier.avgPriceGtUsd}` : null,
      tier.avgPriceGteUsd ? `>= ${tier.avgPriceGteUsd}` : null,
      tier.avgPriceLtUsd ? `< ${tier.avgPriceLtUsd}` : null,
      tier.avgPriceLteUsd ? `<= ${tier.avgPriceLteUsd}` : null
    ].filter(Boolean).join(" and ");
    console.log(`- ${tier.name || "unnamed"}: ${bounds}, exact ${tier.amountInUsdt} ${quoteMeta.symbol}`);
  }
  console.log(`Max slippage: ${execution.maxSlippageBps} bps`);
  console.log(`ERC20 allowance to Permit2: ${fmtDecimal(toDecimalAmount(erc20Permit2Allowance, quoteMeta.decimals), 8)} ${quoteMeta.symbol}`);
  console.log(
    `Permit2 allowance to Universal Router: ${fmtDecimal(toDecimalAmount(internalPermit2Amount, quoteMeta.decimals), 8)} ${quoteMeta.symbol}` +
      (internalPermit2Expired ? " (expired/missing)" : "")
  );
  console.log("");

  if (quoteBalance < spendLimit) {
    console.log("Spend check: WARNING - wallet balance is below MAX_SPEND_USDT");
  } else {
    console.log("Spend check: ok");
  }

  if (erc20Permit2Allowance >= spendLimit && internalPermit2Amount >= spendLimit && !internalPermit2Expired) {
    console.log("Approval check: ok");
  } else {
    await printErc20ApproveDryRun({
      client,
      account,
      token: config.quoteToken,
      spender: config.addresses.permit2,
      gasPrice
    });
    await printPermit2ApproveDryRun({
      client,
      account,
      permit2: config.addresses.permit2,
      token: config.quoteToken,
      spender: config.addresses.infinityUniversalRouter,
      gasPrice
    });
  }

  console.log("");
  console.log("Mode: DRY_RUN. No approval and no transaction sending.");
}

async function printErc20ApproveDryRun({ client, account, token, spender, gasPrice }) {
  console.log("Approval check: may need ERC20 approve to Permit2 before auto execution");
  try {
    const gas = await client.estimateContractGas({
      account,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256]
    });
    const estimatedBnb = gas * gasPrice;
    console.log(`Approve dry-run: ok`);
    console.log(`Approve gas estimate: ${gas.toString()}`);
    console.log(`Approve gas cost at current gas price: ${formatEther(estimatedBnb)} BNB`);
  } catch (error) {
    console.log(`Approve dry-run: failed`);
    console.log(`Reason: ${error.shortMessage || error.message}`);
  }
}

async function printPermit2ApproveDryRun({ client, account, permit2, token, spender, gasPrice }) {
  console.log("Approval check: may need Permit2 approve to Universal Router before auto execution");
  try {
    const maxUint160 = (1n << 160n) - 1n;
    const maxUint48 = (1n << 48n) - 1n;
    const gas = await client.estimateContractGas({
      account,
      address: permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [token, spender, maxUint160, maxUint48]
    });
    const estimatedBnb = gas * gasPrice;
    console.log(`Permit2 approve dry-run: ok`);
    console.log(`Permit2 approve gas estimate: ${gas.toString()}`);
    console.log(`Permit2 approve gas cost at current gas price: ${formatEther(estimatedBnb)} BNB`);
  } catch (error) {
    console.log(`Permit2 approve dry-run: failed`);
    console.log(`Reason: ${error.shortMessage || error.message}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
