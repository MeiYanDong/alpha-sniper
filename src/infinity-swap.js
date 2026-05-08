import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  maxUint256,
  parseAbiParameters
} from "viem";
import { universalRouterAbi } from "./abis.js";

export const INFI_SWAP_COMMAND = "0x10";
export const ACTION_CL_SWAP_EXACT_IN_SINGLE = "0x06";
export const ACTION_SETTLE_ALL = "0x0c";
export const ACTION_TAKE_ALL = "0x0f";

const exactInputSingleParamsAbi = parseAbiParameters(
  "((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData) params"
);
const settleAllAbi = parseAbiParameters("address currency, uint256 maxAmount");
const takeAllAbi = parseAbiParameters("address currency, uint256 minAmount");
const planAbi = parseAbiParameters("bytes actions, bytes[] params");

export function normalizePoolKey(poolKey) {
  return {
    currency0: poolKey.currency0 ?? poolKey[0],
    currency1: poolKey.currency1 ?? poolKey[1],
    hooks: poolKey.hooks ?? poolKey[2],
    poolManager: poolKey.poolManager ?? poolKey[3],
    fee: poolKey.fee ?? poolKey[4],
    parameters: poolKey.parameters ?? poolKey[5]
  };
}

export function poolKeyTuple(poolKey) {
  const key = normalizePoolKey(poolKey);
  return [
    key.currency0,
    key.currency1,
    key.hooks,
    key.poolManager,
    Number(key.fee),
    key.parameters
  ];
}

export function applySlippageBps(amountOut, slippageBps) {
  const bps = BigInt(slippageBps);
  return (amountOut * (10_000n - bps)) / 10_000n;
}

export function buildInfinityExactInputSinglePlan({
  poolKey,
  zeroForOne,
  amountIn,
  amountOutMinimum,
  inputCurrency,
  outputCurrency,
  hookData = "0x"
}) {
  const actions = concatHex([
    ACTION_CL_SWAP_EXACT_IN_SINGLE,
    ACTION_SETTLE_ALL,
    ACTION_TAKE_ALL
  ]);
  const params = [
    encodeAbiParameters(exactInputSingleParamsAbi, [
      [poolKeyTuple(poolKey), zeroForOne, amountIn, amountOutMinimum, hookData]
    ]),
    encodeAbiParameters(settleAllAbi, [inputCurrency, maxUint256]),
    encodeAbiParameters(takeAllAbi, [outputCurrency, amountOutMinimum])
  ];

  return encodeAbiParameters(planAbi, [actions, params]);
}

export function buildUniversalRouterExecuteCalldata({ commands, inputs, deadline }) {
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [commands, inputs, deadline]
  });
}

export function buildInfinityExactInputSingleExecute({
  poolKey,
  zeroForOne,
  amountIn,
  amountOutMinimum,
  inputCurrency,
  outputCurrency,
  deadline,
  hookData = "0x"
}) {
  const commands = INFI_SWAP_COMMAND;
  const plan = buildInfinityExactInputSinglePlan({
    poolKey,
    zeroForOne,
    amountIn,
    amountOutMinimum,
    inputCurrency,
    outputCurrency,
    hookData
  });
  const inputs = [plan];
  const calldata = buildUniversalRouterExecuteCalldata({ commands, inputs, deadline });

  return { commands, inputs, deadline, calldata };
}
