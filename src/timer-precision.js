function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const samples = Math.floor(toPositiveNumber(getArg("--samples", "1000"), 1000));
  const intervalMs = toPositiveNumber(getArg("--interval-ms", "10"), 10);
  const warmupMs = toPositiveNumber(getArg("--warmup-ms", "250"), 250);
  const errors = [];

  await sleep(warmupMs);

  const startedAt = performance.now();
  for (let index = 1; index <= samples; index += 1) {
    const targetAt = startedAt + index * intervalMs;
    const delay = Math.max(0, targetAt - performance.now());
    await sleep(delay);
    errors.push(performance.now() - targetAt);
  }

  const late = errors.filter((value) => value > 0);
  const early = errors.filter((value) => value < 0);
  const abs = errors.map((value) => Math.abs(value));

  console.log(
    `Timer precision: samples=${samples} interval=${intervalMs}ms warmup=${warmupMs}ms runtime=${Math.round(performance.now() - startedAt)}ms`
  );
  console.log(
    `errorMs p50=${percentile(errors, 50).toFixed(3)} p95=${percentile(errors, 95).toFixed(3)} p99=${percentile(errors, 99).toFixed(3)} max=${Math.max(...errors).toFixed(3)} min=${Math.min(...errors).toFixed(3)}`
  );
  console.log(
    `absErrorMs p50=${percentile(abs, 50).toFixed(3)} p95=${percentile(abs, 95).toFixed(3)} p99=${percentile(abs, 99).toFixed(3)} max=${Math.max(...abs).toFixed(3)}`
  );
  console.log(`late=${late.length} early=${early.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
