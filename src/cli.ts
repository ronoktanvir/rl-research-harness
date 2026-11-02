import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { inspectCoworkerProject, inspectCoworkerRun } from "./integrations/coworker/index.ts";
import { createEvidencePacket, writeDecisionArtifacts } from "./research/index.ts";
import { runCliReview } from "./workers/cli.ts";
import { runCliCouncil } from "./workers/council.ts";
import type { CliBackend } from "./workers/cli.ts";

const USAGE = `RL research harness

Read-only inspection (no model calls, no training):
  npm run harness -- inspect <CoworkeRL directory>
  npm run harness -- observe <CoworkeRL directory> <relative/report.json>

Subscription-backed review (uses the selected official client's allowance):
  npm run harness -- review <packet.json> <codex|claude> <output-directory>
  npm run harness -- smoke <codex|claude>

review performs independent methods, systems and adversarial reviews and up to two
proposal revisions. It saves JSON/Markdown decisions; it cannot launch training.
smoke makes one short, tool-suppressed client call. API fallback is not configured.
`;

function backend(value: string | undefined): CliBackend {
  if (value !== "codex" && value !== "claude") throw new Error("Select codex or claude explicitly");
  return value;
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") { console.log(USAGE); return 0; }
  if (command === "inspect" && rest.length === 1) {
    console.log(JSON.stringify(await inspectCoworkerProject(rest[0]!), null, 2));
    return 0;
  }
  if (command === "observe" && rest.length === 2) {
    const inspection = await inspectCoworkerRun(rest[0]!, rest[1]!);
    console.log(JSON.stringify(inspection, null, 2));
    return inspection.diagnostics.some(item => item.severity === "error") ? 1 : 0;
  }
  if (command === "smoke" && rest.length === 1) {
    const result = await runCliReview({ backend: backend(rest[0]), prompt: "Return exactly READY. Do not call any tools.", timeoutMs: 45_000 });
    console.log(JSON.stringify(result, null, 2));
    return result.status === "succeeded" && result.text.trim() === "READY" ? 0 : 1;
  }
  if (command === "review" && rest.length === 3) {
    const path = rest[0]!;
    if ((await stat(path)).size > 512_000) throw new Error("Evidence packet exceeds 512,000 bytes");
    const packet = createEvidencePacket(JSON.parse(await readFile(path, "utf8")));
    const selected = backend(rest[1]);
    const decision = await runCliCouncil({ councilId: `${packet.packetId}-review`, packet,
      workers: [
        { id: "methods", role: "Scientific methods, comparisons, uncertainty and leakage", backend: selected },
        { id: "systems", role: "Feasibility, execution, recovery and resource control", backend: selected },
        { id: "adversary", role: "Reward exploitation, evaluator defects and alternative explanations", backend: selected },
      ],
      reviser: { backend: selected },
    });
    const artifacts = await writeDecisionArtifacts(rest[2]!, decision);
    console.log(JSON.stringify({ status: decision.status, blockers: decision.blockers, artifacts }, null, 2));
    return decision.status === "approved" ? 0 : 2;
  }
  throw new Error(`Invalid command or arguments.\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : "Harness command failed");
    process.exitCode = 1;
  });
}
