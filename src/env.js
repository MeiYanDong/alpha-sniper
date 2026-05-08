import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const loadedFiles = [];

function parseEnvValue(raw) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadEnvFile(file, { override = false } = {}) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (override || process.env[key] === undefined) {
      process.env[key] = parseEnvValue(rawValue);
    }
  }
  loadedFiles.push(file);
  return true;
}

export function loadProjectEnv() {
  const projectEnvLocal = path.resolve(process.cwd(), ".env.local");
  const sharedProviders = path.join(os.homedir(), ".codex/secrets/evm-rpc-providers.env");
  const projectEnv = path.resolve(process.cwd(), ".env");

  loadEnvFile(projectEnvLocal);
  loadEnvFile(sharedProviders);
  loadEnvFile(projectEnv);

  return [...loadedFiles];
}
