import { createJobDeclaration } from "../../src/execution/worker.ts";
import type { ServiceSnapshot } from "../../src/execution/types.ts";

export const workerNow = new Date("2026-11-02T12:00:00.000Z");
export function workerDeclaration(actionId = "action-one") {
  return createJobDeclaration({ actionId, backendKey: actionId, manifestDigest: "a".repeat(64), planDigest: "b".repeat(64), workerId: "worker-one",
    command: { executable: "/usr/bin/python3", args: ["-c", "pass"], cwd: "/srv/source", environment: {} },
    limits: { runtimeMs: 1000, startTimeoutMs: 1000, stopTimeoutMs: 1000, memoryMaxBytes: 104857600, tasksMax: 8 },
    deadlineAt: "2026-11-02T12:01:00.000Z", host: { machineId: "1".repeat(32), bootId: "11111111-1111-1111-1111-111111111111" } });
}
export function workerSnapshot(declaration = workerDeclaration()): ServiceSnapshot {
  return { identity: declaration.request.identity, host: declaration.request.expectedHost, observedAt: workerNow.toISOString(), invocationId: "2".repeat(32),
    loadState: "loaded", activeState: "active", subState: "running", result: "success", mainPid: 123, execMainCode: 0, execMainStatus: 0,
    controlGroup: `/system.slice/${declaration.request.identity.unitName}`, cgroupPopulated: true };
}
