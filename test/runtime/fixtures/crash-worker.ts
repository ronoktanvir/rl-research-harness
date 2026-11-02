import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openPiRuntime } from "../../../src/runtime/index.ts";
import { deferred } from "../helpers.ts";

const [storagePath, policy] = process.argv.slice(2);
if (!storagePath || (policy !== "safe" && policy !== "unsafe")) throw new Error("Expected path and replay policy");
const keepAlive = setInterval(() => {}, 60_000);
const started = deferred<void>();
const registry = createRegistry();
registry.install(defineExtension({
  name: "qualification",
  tools: [defineTool({
    name: "hold", description: "Controlled test tool", parameters: Type.Object({}), replay: policy,
    execute: async () => {
      started.resolve();
      return new Promise<never>(() => {});
    },
  })],
}));
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "crash-call" }), { stopReason: "toolUse" })]);
const models = createModels();
models.setProvider(faux.provider);
const runtime = await openPiRuntime({
  storagePath, models, registry, initialAgent: { model: { provider: "faux", modelId: "faux-1" } },
  settings: { compaction: { enabled: false }, retry: { enabled: false }, stream: { maxRetries: 0 } },
});
const receipt = await runtime.submit({ requestId: "crash-request", message: "Run the controlled tool" });
await started.promise;
process.stdout.write(`${JSON.stringify({ kind: "ready", submissionId: receipt.id })}\n`);
// The parent kills this process while the tool's durable execution intent is live.
await new Promise<never>(() => {});
clearInterval(keepAlive);
