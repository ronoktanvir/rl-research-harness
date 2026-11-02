import type { ExperimentLedger, JsonObject } from "../ledger/types.ts";
import { encode, hash, keys } from "../ledger/validation.ts";
import { freezeSnapshot } from "../research/evidence.ts";
import { copyCoworkerInvestigationData, normalizeCoworkerInvestigationRequest, runCoworkerInvestigation, validateCoworkerInvestigationPreparation } from "../integrations/coworker/investigation.ts";
import { createCoworkerInvestigationWorker, validateCoworkerInvestigationDescriptor } from "../integrations/coworker/investigation-worker.ts";
import type { CoworkerInvestigationWorker } from "../integrations/coworker/investigation-worker.ts";
import type { ResearchTaskHandler } from "./handlers.ts";
import type { HandlerPolicy } from "./types.ts";

export const INVESTIGATION_HANDLER_POLICY: Readonly<HandlerPolicy> = Object.freeze({
  kind: "coworker_investigation", version: "1", replay: "reconcile_safe", callUnits: 0, resourceKey: null,
});
export const INVESTIGATION_TASK_MEANING = "Bounded read-only evidence investigation archived; scientific requests remain open and execution is not authorized.";
export type InvestigationRequest = ReturnType<typeof normalizeCoworkerInvestigationRequest>;
export type InvestigationWorkerDescriptor = CoworkerInvestigationWorker["descriptor"];
export interface InvestigationTaskHandler extends ResearchTaskHandler { readonly workerDescriptor: InvestigationWorkerDescriptor }
export interface InvestigationHandlerOptions {
  ledger: ExperimentLedger;
  projects: Record<string, { root: string }>;
  /** Trusted setup/test seam; never supplied by queue input. */
  worker?: CoworkerInvestigationWorker;
  pythonExecutable?: string;
  now?: () => Date;
}

export function investigationTaskInput(raw: unknown): { request: InvestigationRequest; worker: InvestigationWorkerDescriptor } {
  // Reject accessors, hidden properties and oversized structures before
  // the normalizer or handler can observe caller-controlled mutable references.
  const value = copyCoworkerInvestigationData(raw); keys(value, ["request", "worker"]);
  return { request: normalizeCoworkerInvestigationRequest(value.request), worker: validateCoworkerInvestigationDescriptor(value.worker) };
}

/** One zero-call operation. The configured root and fixed worker are not task authority. */
export function createInvestigationTaskHandlers(options: InvestigationHandlerOptions): InvestigationTaskHandler[] {
  const projects = freezeSnapshot(options.projects), supplied = options.worker ?? createCoworkerInvestigationWorker({ pythonExecutable: options.pythonExecutable ?? "/usr/bin/python3" });
  const descriptor = validateCoworkerInvestigationDescriptor(supplied.descriptor);
  const worker = Object.freeze({ descriptor, run: supplied.run.bind(supplied) });
  const checked = (raw: unknown, projectId: string) => {
    const input = investigationTaskInput(raw);
    if (!Object.hasOwn(projects, projectId) || input.request.projectId !== projectId) throw new Error("Investigation project is not configured or does not match the task");
    if (encode(input.worker) !== encode(descriptor)) throw new Error("Investigation worker changed since task preparation");
    validateCoworkerInvestigationPreparation(options.ledger, input.request, { root: projects[projectId]!.root, worker: descriptor });
    return input;
  };
  return [{ policy: INVESTIGATION_HANDLER_POLICY, workerDescriptor: freezeSnapshot(descriptor) as InvestigationWorkerDescriptor,
    validate(raw, projectId) { checked(raw, projectId); },
    async execute(claim, signal) {
      const input = checked(claim.task.input, claim.task.projectId);
      if (claim.task.kind !== INVESTIGATION_HANDLER_POLICY.kind || claim.task.handlerVersion !== INVESTIGATION_HANDLER_POLICY.version
        || encode(claim.task.handler) !== encode(INVESTIGATION_HANDLER_POLICY)) throw new Error("Investigation handler policy changed");
      if (signal.aborted) return { status: "cancelled", result: { reason: "cancelled_before_investigation" } };
      const observation = await runCoworkerInvestigation(options.ledger, input.request,
        { root: projects[claim.task.projectId]!.root, worker, signal, ...(options.now ? { now: options.now } : {}) });
      const result: JsonObject = { kind: INVESTIGATION_HANDLER_POLICY.kind, observationId: observation.eventId,
        observationDigest: observation.digest, requestDigest: hash(input.request), workerDigest: hash(input.worker), meaning: INVESTIGATION_TASK_MEANING };
      return { status: signal.aborted ? "cancelled" : "completed", result };
    },
  }];
}
