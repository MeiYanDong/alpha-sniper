import { createWalletClient, formatEther, http, maxUint256, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { erc20Abi, permit2Abi } from "./abis.js";
import { loadConfigFromArgs, sameAddress } from "./config.js";
import { getExecutionConfig } from "./decision.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";
import { createBscClient, getTokenMeta } from "./pools.js";

function loadAccount() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env.local");
  return privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
}

function requireSendFlag() {
  if (!process.argv.includes("--send")) {
    throw new Error("Refusing to send. Re-run with --send only after explicit approval.");
  }
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function tokenSpecs(config) {
  const token = argValue("--token", "quote");
  const specs = {
    quote: { address: config.quoteToken, role: "quote" },
    target: { address: config.targetToken, role: "target" }
  };
  if (token === "both") return [specs.quote, specs.target];
  if (!specs[token]) throw new Error("--token must be quote, target, or both");
  return [specs[token]];
}

async function main() {
  const config = loadConfigFromArgs();
  const account = loadAccount();
  const configuredWallet = process.env.WALLET_ADDRESS;
  if (configuredWallet && !sameAddress(account.address, configuredWallet)) {
    throw new Error("PRIVATE_KEY does not match WALLET_ADDRESS");
  }
  requireSendFlag();

  const publicClient = createBscClient(config.rpcUrls);
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(config.rpcUrl, { timeout: 25_000 })
  });
  const execution = getExecutionConfig(config);

  console.log(`${config.name} approve Permit2 / Universal Router`);
  console.log(`Wallet: ${account.address}`);

  for (const spec of tokenSpecs(config)) {
    const meta = await getTokenMeta(publicClient, spec.address);
    const requiredRaw = await resolveApprovalAmount({
      publicClient,
      account,
      token: spec.address,
      meta,
      fallback:
        spec.role === "quote"
          ? parseUnits(execution.maxSpendUsdt, meta.decimals)
          : await publicClient.readContract({
              address: spec.address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [account.address]
            })
    });
    await ensureErc20Permit2Approval({
      publicClient,
      walletClient,
      account,
      token: spec.address,
      meta,
      permit2: config.addresses.permit2,
      requiredRaw,
      approvalRaw: requiredRaw
    });
    await ensureInternalPermit2Approval({
      publicClient,
      walletClient,
      account,
      permit2: config.addresses.permit2,
      token: spec.address,
      meta,
      spender: config.addresses.infinityUniversalRouter,
      requiredRaw,
      approvalRaw: requiredRaw
    });
  }
}

async function resolveApprovalAmount({ publicClient, account, token, meta, fallback }) {
  const amount = argValue("--amount");
  if (!amount) return fallback;
  if (amount === "balance") {
    return publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    });
  }
  if (amount === "max") return maxUint256;
  return parseUnits(amount, meta.decimals);
}

async function ensureErc20Permit2Approval({
  publicClient,
  walletClient,
  account,
  token,
  meta,
  permit2,
  requiredRaw,
  approvalRaw
}) {
  const currentAllowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, permit2]
  });

  console.log("");
  console.log(`${meta.symbol} ERC20 -> Permit2`);
  console.log(`Current allowance: ${fmtDecimal(toDecimalAmount(currentAllowance, meta.decimals), 8)} ${meta.symbol}`);

  if (currentAllowance >= requiredRaw) {
    console.log("Approval already sufficient. No ERC20 approval sent.");
    return;
  }

  const [gas, gasPrice] = await Promise.all([
    publicClient.estimateContractGas({
      account,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [permit2, approvalRaw]
    }),
    publicClient.getGasPrice()
  ]);
  console.log(`Gas estimate: ${gas.toString()}`);
  console.log(`Estimated gas cost: ${formatEther(gas * gasPrice)} BNB`);

  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [permit2, approvalRaw]
  });
  console.log(`ERC20 approve tx sent: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`ERC20 approve tx status: ${receipt.status}`);
}

async function ensureInternalPermit2Approval({
  publicClient,
  walletClient,
  account,
  permit2,
  token,
  meta,
  spender,
  requiredRaw,
  approvalRaw
}) {
  const [amount, expiration] = await publicClient.readContract({
    address: permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [account.address, token, spender]
  });
  const expired = Number(expiration) === 0 || Number(expiration) <= Math.floor(Date.now() / 1000);

  console.log("");
  console.log(`${meta.symbol} Permit2 -> Universal Router`);
  console.log(
    `Current allowance: ${fmtDecimal(toDecimalAmount(amount, meta.decimals), 8)} ${meta.symbol}` +
      (expired ? " (expired/missing)" : "")
  );

  if (amount >= requiredRaw && !expired) {
    console.log("Approval already sufficient. No Permit2 approval sent.");
    return;
  }

  const maxUint160 = (1n << 160n) - 1n;
  const maxUint48 = (1n << 48n) - 1n;
  const approvalUint160 = approvalRaw > maxUint160 ? maxUint160 : approvalRaw;
  const [gas, gasPrice] = await Promise.all([
    publicClient.estimateContractGas({
      account,
      address: permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [token, spender, approvalUint160, maxUint48]
    }),
    publicClient.getGasPrice()
  ]);
  console.log(`Gas estimate: ${gas.toString()}`);
  console.log(`Estimated gas cost: ${formatEther(gas * gasPrice)} BNB`);

  const hash = await walletClient.writeContract({
    address: permit2,
    abi: permit2Abi,
    functionName: "approve",
    args: [token, spender, approvalUint160, maxUint48]
  });
  console.log(`Permit2 approve tx sent: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Permit2 approve tx status: ${receipt.status}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
