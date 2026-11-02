import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { openExperimentLedger } from "../ledger/index.ts";
import { id, integer, keys, object, text } from "../ledger/validation.ts";
import { openTaskQueue, QueueError } from "./index.ts";
import { createResearchTaskHandlers } from "./handlers.ts";
import { createCouncilTaskHandlers } from "./council-handlers.ts";
import { createInvestigationTaskHandlers } from "./investigation-handlers.ts";
import type { CoworkerInvestigationWorker } from "../integrations/coworker/investigation-worker.ts";
import { ledgerAuthority, registerResearchHandlers } from "./runner.ts";
import type { ExperimentLedger } from "../ledger/types.ts";
import type { ResearchTaskHandler, ResearchTaskHandlerOptions } from "./handlers.ts";
import type { TaskQueue } from "./types.ts";

export interface InvocationLimits { maxClientInvocations: number; maxParallel: number }
export interface HarnessConfig {
  schemaVersion: 1;
  ledgerPath: string;
  queuePath: string;
  workerId: string;
  /** Trusted absolute Python 3.11+ runtime for read-only historical inspection. */
  investigationPythonExecutable?: string;
  limits: InvocationLimits;
  projects: Record<string, { root: string; summaryDirectory: string; limits: InvocationLimits }>;
}

/** Read a bounded JSON configuration/request without executing project code. */
export async function readBoundedJson(path: string, maximumBytes = 512_000): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 2_000_000) throw new Error("Invalid JSON byte limit");
  // A FIFO can block in open before fstat gets a chance to reject it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Expected a regular JSON file");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximumBytes) throw new Error(`JSON file exceeds ${maximumBytes} bytes`);
    return JSON.parse(buffer.toString("utf8", 0, size)) as unknown;
  } finally { await handle.close(); }
}

function limits(value: unknown): asserts value is InvocationLimits {
  keys(value, ["maxClientInvocations", "maxParallel"]);
  integer(value.maxClientInvocations); integer(value.maxParallel, 1);
  if ((value.maxClientInvocations as number) > 1_000_000 || (value.maxParallel as number) > 32) throw new Error("Invocation limits exceed the supported controller range");
}

export function parseHarnessConfig(raw: unknown, baseDirectory: string): HarnessConfig {
  const input: unknown = structuredClone(raw);
  const required = ["schemaVersion", "ledgerPath", "queuePath", "workerId", "limits", "projects"];
  keys(input, [...required, "investigationPythonExecutable"], required);
  if (input.schemaVersion !== 1) throw new Error("Unsupported harness configuration version");
  text(input.ledgerPath); text(input.queuePath); id(input.workerId); limits(input.limits); object(input.projects);
  const python = input.investigationPythonExecutable;
  if (python !== undefined && (typeof python !== "string" || !isAbsolute(python) || normalize(python) !== python || python === "/"
    || python.length > 4096 || /[\0\r\n\\]/u.test(python))) throw new Error("Investigation Python must be a canonical absolute path");
  const projects: HarnessConfig["projects"] = Object.create(null) as HarnessConfig["projects"];
  for (const [projectId, config] of Object.entries(input.projects)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(projectId)) throw new Error("Invalid project ID");
    keys(config, ["root", "summaryDirectory", "limits"]); text(config.root); text(config.summaryDirectory); limits(config.limits);
    projects[projectId] = { root: resolve(baseDirectory, config.root), summaryDirectory: resolve(baseDirectory, config.summaryDirectory), limits: config.limits };
  }
  if (!Object.keys(projects).length || Object.keys(projects).length > 100) throw new Error("Configure 1–100 research projects");
  const ledgerPath = resolve(baseDirectory, input.ledgerPath), queuePath = resolve(baseDirectory, input.queuePath);
  if (ledgerPath === queuePath) throw new Error("Research queue and experiment ledger require different files");
  return { schemaVersion: 1, ledgerPath, queuePath, workerId: input.workerId, limits: input.limits, projects,
    ...(typeof python === "string" ? { investigationPythonExecutable: python } : {}) };
}

export async function loadHarnessConfig(path: string): Promise<HarnessConfig> {
  return parseHarnessConfig(await readBoundedJson(path), dirname(resolve(path)));
}

export interface ConfiguredHarness {
  config: HarnessConfig;
  ledger: ExperimentLedger;
  queue: TaskQueue;
  handlers: ResearchTaskHandler[];
  close(): void;
}

/** Operator configuration is trusted authority for these invocation caps. Updating a cap
 * preserves all consumed units; reopening never replenishes the recorded global/project
 * invocation allowance. Provider quota is separate and is not measured by these counters.
 */
export function openConfiguredHarness(raw: HarnessConfig,
  injections: Omit<Partial<ResearchTaskHandlerOptions>, "ledger" | "projects"> & { investigationWorker?: CoworkerInvestigationWorker } = {}): ConfiguredHarness {
  const config = parseHarnessConfig(raw, process.cwd());
  const ledger = openExperimentLedger({ path: config.ledgerPath, ...(injections.now ? { now: injections.now } : {}) });
  let queue: TaskQueue | undefined;
  try {
    queue = openTaskQueue({ path: config.queuePath, authority: projectId => ledgerAuthority(ledger, projectId),
      ...(injections.now ? { now: injections.now } : {}) });
    const fixedQueue = queue;
    const projects = Object.fromEntries(Object.entries(config.projects).map(([projectId, value]) => [projectId,
      { root: value.root, summaryDirectory: value.summaryDirectory }]));
    const handlers = [...createResearchTaskHandlers({ ...injections, ledger, projects }),
      ...createCouncilTaskHandlers({ ledger, projects: Object.keys(projects),
        ...(injections.review ? { review: injections.review } : {}), ...(injections.now ? { now: injections.now } : {}) }),
      ...createInvestigationTaskHandlers({ ledger, projects, ...(injections.investigationWorker ? { worker: injections.investigationWorker } : {}),
        ...(config.investigationPythonExecutable ? { pythonExecutable: config.investigationPythonExecutable } : {}),
        ...(injections.now ? { now: injections.now } : {}) })];
    registerResearchHandlers(queue, handlers);
    for (const [scopeId, value] of [["global", config.limits], ...Object.entries(config.projects).map(([projectId, project]) => [`project:${projectId}`, project.limits])] as [string, InvocationLimits][]) {
      let previous;
      try { previous = queue.getBudget(scopeId); }
      catch (error) { if (!(error instanceof QueueError && error.code === "missing")) throw error; }
      if (!previous || previous.maxCalls !== value.maxClientInvocations || previous.maxParallel !== value.maxParallel) {
        queue.configureBudget({ scopeId, expectedVersion: previous?.version ?? 0,
          maxCalls: value.maxClientInvocations, maxParallel: value.maxParallel });
      }
    }
    let closed = false;
    return { config, ledger, queue, handlers, close() {
      if (closed) return;
      fixedQueue.close(); ledger.close(); closed = true;
    } };
  } catch (error) { try { queue?.close(); } finally { ledger.close(); } throw error; }
}
