import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadProjectEnv } from "./env.js";

loadProjectEnv();

export function loadConfigFromArgs(argv = process.argv) {
  const index = argv.indexOf("--config");
  const configPath = index >= 0 ? argv[index + 1] : "config/share.json";
  if (!configPath) {
    throw new Error("Missing value after --config");
  }

  const absolutePath = path.resolve(process.cwd(), configPath);
  const config = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const rpcUrls = selectRpcUrls(config);
  const rpcUrl = rpcUrls[0];

  return { ...config, rpcUrl, rpcUrls, configPath: absolutePath };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function selectRpcUrls(config) {
  if (config.rpcUrlEnv === "BSC_RPC_URL") {
    return unique([process.env.BSC_RPC_URL, process.env.CHAINSTACK_BSC_RPC_URL, config.defaultRpcUrl]);
  }

  return unique([process.env[config.rpcUrlEnv], config.defaultRpcUrl]);
}

export function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
