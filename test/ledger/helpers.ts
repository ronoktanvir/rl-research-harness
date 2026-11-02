import type { AdmitActionInput, ExperimentLedger, ExperimentManifest } from "../../src/ledger/index.ts";
export const fixedNow = () => new Date("2026-11-02T12:00:00.000Z");
export const deadline = "2026-11-02T12:00:30.000Z";
export function manifest(): ExperimentManifest {
  return { schemaVersion: 1, code: { revision: "fixture-commit", dirtyPatchSha256: null }, environment: { imageDigest: `sha256:${"b".repeat(64)}`, dependenciesDigest: "c".repeat(64) }, adapter: { kind: "conventional_rl", name: "fixture", config: { steps: 2 } }, data: { version: "fixture-data", splitsDigest: "d".repeat(64) }, model: { version: "fixture-policy" }, reward: { version: "fixture-reward" }, evaluator: { version: "fixture-evaluator" }, seeds: [7], resources: { maxDurationSeconds: 60, maxCostMicrodollars: "100000" }, evaluationPolicy: { metric: "heldout-return" } };
}
export function initialize(ledger: ExperimentLedger, amount = 1000n): string {
  for (const scopeId of ["global", "project:study"]) {
    ledger.configureBudget({ scopeId, parentScopeId: scopeId === "global" ? null : "global", expectedRevision: 0, limitMicrodollars: amount });
    ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: ["fixture"], allowedOperations: ["launch", "evaluate"], requiredChecks: ["adapter-contract"] });
  }
  const registered = ledger.registerManifest(manifest());
  ledger.createRun({ runId: "run-one", projectId: "study", manifestDigest: registered.digest, replicaId: "replica-one" });
  ledger.recordValidation({ validationId: "check-one", manifestDigest: registered.digest, check: "adapter-contract", source: "trusted-validator", sequence: 1, status: "passed", evidence: { test: "synthetic" } });
  return registered.digest;
}
export function admission(revision = 1, amount = 100n): AdmitActionInput {
  return { runId: "run-one", operation: "launch", operationRevision: revision, backend: "fixture", payload: { task: "synthetic" }, reservation: { amountMicrodollars: amount, category: "compute", basis: "fixture upper bound" } };
}
