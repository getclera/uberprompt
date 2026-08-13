import { closeDb } from "@uberprompt/sdk";
import { versionDeltas, versionStats, type VersionStats } from "../compare";

const promptName = process.env.UBERPROMPT_COMPARE_PROMPT;
const asJson = process.env.UBERPROMPT_COMPARE_JSON === "1";

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function score(row: VersionStats): string {
  return row.avgScore === undefined ? "  -  " : row.avgScore.toFixed(2);
}

function arrow(delta: number, higherIsBetter: boolean): string {
  if (Math.abs(delta) < 1e-9) return "=";
  const better = higherIsBetter ? delta > 0 : delta < 0;
  return better ? "improved" : "regressed";
}

async function main(): Promise<void> {
  const stats = await versionStats(promptName);

  if (asJson) {
    console.log(JSON.stringify({ stats, deltas: versionDeltas(stats) }, null, 2));
    await closeDb();
    return;
  }

  if (stats.length === 0) {
    console.log("no traces carry a prompt binding yet — run the demo app or seed traces first");
    await closeDb();
    return;
  }

  console.log("prompt                       ver  traces  errors  err%   score  latency  tokens in/out");
  console.log("-".repeat(92));
  for (const row of stats) {
    console.log(
      [
        row.promptName.padEnd(28),
        `v${row.promptVersion}`.padEnd(4),
        String(row.traces).padStart(6),
        String(row.errors).padStart(7),
        pct(row.errorRate).padStart(6),
        score(row).padStart(7),
        `${String(row.avgLatencyMs).padStart(6)}ms`,
        `${row.avgInputTokens ?? "-"}/${row.avgOutputTokens ?? "-"}`,
      ].join("  "),
    );
  }

  const deltas = versionDeltas(stats);
  if (deltas.length === 0) {
    console.log("\nonly one version per prompt so far — nothing to compare yet.");
    console.log("after stage 3 applies a proposal and the app reruns, this shows the before/after.");
    await closeDb();
    return;
  }

  console.log("\n--- version over version ---");
  for (const delta of deltas) {
    console.log(`\n${delta.promptName}: v${delta.from.promptVersion} -> v${delta.to.promptVersion}`);
    if (delta.scoreDelta !== undefined) {
      console.log(
        `  score      ${delta.from.avgScore?.toFixed(2)} -> ${delta.to.avgScore?.toFixed(2)}   ` +
          `${delta.scoreDelta >= 0 ? "+" : ""}${delta.scoreDelta.toFixed(2)}  ${arrow(delta.scoreDelta, true)}`,
      );
    }
    console.log(
      `  error rate ${pct(delta.from.errorRate)} -> ${pct(delta.to.errorRate)}   ` +
        `${delta.errorRateDelta >= 0 ? "+" : ""}${pct(delta.errorRateDelta)}  ${arrow(delta.errorRateDelta, false)}`,
    );
    console.log(
      `  latency    ${delta.from.avgLatencyMs}ms -> ${delta.to.avgLatencyMs}ms   ` +
        `${delta.latencyDelta >= 0 ? "+" : ""}${delta.latencyDelta}ms  ${arrow(delta.latencyDelta, false)}`,
    );
  }
}

main()
  .then(closeDb)
  .catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
