import { formatEther } from "viem";
import { loadConfigFromArgs } from "./config.js";
import { erc20Abi, permit2Abi } from "./abis.js";
import { createBscClient, getTokenMeta } from "./pools.js";
import { fmtDecimal, toDecimalAmount } from "./math.js";

async function readTokenState({ client, token, owner, spenders }) {
  const meta = await getTokenMeta(client, token);
  const [balance, ...allowances] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    ...spenders.map((spender) =>
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, spender.address]
      })
    )
  ]);

  return {
    meta,
    balance,
    allowances: spenders.map((spender, index) => ({
      ...spender,
      raw: allowances[index],
      human: toDecimalAmount(allowances[index], meta.decimals)
    }))
  };
}

async function main() {
  const config = loadConfigFromArgs();
  const owner = process.env.WALLET_ADDRESS;
  if (!owner || owner === "0xYourBurnerWalletAddress") {
    throw new Error("Set WALLET_ADDRESS in .env to your burner wallet address.");
  }

  const client = createBscClient(config.rpcUrls);
  const spenders = [
    { name: "Permit2", address: config.addresses.permit2 },
    { name: "Infinity Universal Router", address: config.addresses.infinityUniversalRouter },
    { name: "Pancake Smart Router", address: config.addresses.pancakeSmartRouter }
  ];
  const [bnbBalance, quote, target] = await Promise.all([
    client.getBalance({ address: owner }),
    readTokenState({ client, token: config.quoteToken, owner, spenders }),
    readTokenState({ client, token: config.targetToken, owner, spenders })
  ]);

  console.log(`${config.name} wallet check`);
  console.log(`Wallet: ${owner}`);
  console.log(`BNB: ${formatEther(bnbBalance)}`);
  console.log("");

  printToken(quote);
  printToken(target);
  await printPermit2Allowance({
    client,
    owner,
    token: config.quoteToken,
    permit2: config.addresses.permit2,
    spender: config.addresses.infinityUniversalRouter,
    label: `${quote.meta.symbol} Permit2 -> Infinity Universal Router`,
    decimals: quote.meta.decimals
  });
  await printPermit2Allowance({
    client,
    owner,
    token: config.targetToken,
    permit2: config.addresses.permit2,
    spender: config.addresses.infinityUniversalRouter,
    label: `${target.meta.symbol} Permit2 -> Infinity Universal Router`,
    decimals: target.meta.decimals
  });
  console.log("Mode: READ_ONLY. No approval and no transaction sending.");
}

function printToken(state) {
  console.log(`${state.meta.symbol} ${state.meta.address}`);
  console.log(`- balance: ${fmtDecimal(toDecimalAmount(state.balance, state.meta.decimals), 8)}`);
  for (const allowance of state.allowances) {
    console.log(`- allowance to ${allowance.name}: ${fmtDecimal(allowance.human, 8)}`);
  }
  console.log("");
}

async function printPermit2Allowance({ client, owner, token, permit2, spender, label, decimals }) {
  const [amount, expiration] = await client.readContract({
    address: permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, spender]
  });
  const expired = Number(expiration) === 0 || Number(expiration) <= Math.floor(Date.now() / 1000);
  console.log(`${label}`);
  console.log(`- internal allowance: ${fmtDecimal(toDecimalAmount(amount, decimals), 8)}${expired ? " (expired/missing)" : ""}`);
  console.log("");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
