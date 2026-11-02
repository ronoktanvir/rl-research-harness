export type * from "./types.js";
export { QueueError } from "./validation.js";
import { LocalTaskQueue } from "./queue.js";
import type { QueueOptions, TaskQueue } from "./types.js";
/** Opens a distinct, exclusively owned queue. Global/project authority comes from the ledger. */
export function openTaskQueue(options: QueueOptions): TaskQueue { return new LocalTaskQueue(options); }
