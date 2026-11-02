export type * from "./types.js";
export { LedgerError } from "./validation.js";
import { LocalExperimentLedger } from "./ledger.js";
import type { ExperimentLedger, LedgerOptions } from "./types.js";

/** Opens one exclusively owned local ledger and recovers interrupted dispatches as unknown. */
export function openExperimentLedger(options: LedgerOptions): ExperimentLedger {
  return new LocalExperimentLedger(options);
}
