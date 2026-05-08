import { spawn } from "node:child_process";
import process from "node:process";
import "dotenv/config";

const intervalMs = Number(process.env.WATCH_INTERVAL_MS || 5000);
let running = false;

function runOnce() {
  if (running) return;
  running = true;
  console.clear();
  const child = spawn(process.execPath, ["src/status.js", ...process.argv.slice(2)], {
    stdio: "inherit"
  });
  child.on("exit", () => {
    running = false;
  });
}

runOnce();
setInterval(runOnce, intervalMs);
