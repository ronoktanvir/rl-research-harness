import assert from "node:assert/strict";
import test from "node:test";
import { COWORKER_SOURCE_REVISION, prepareCoworkerAttempt } from "../../src/integrations/coworker/attempt-plan.ts";
import { coworkerAttemptFixture, rebindCoworkerFixture } from "./coworker-attempt-fixtures.ts";

test("the inspected trainer cannot claim disabled helper caching by omitting its cache flag", () => {
  const invalid = coworkerAttemptFixture();
  (invalid.configuration.helper as unknown as { cache: string }).cache = "disabled";
  assert.throws(() => prepareCoworkerAttempt(rebindCoworkerFixture(invalid)), /caching|cache/u);
  const plan = prepareCoworkerAttempt(coworkerAttemptFixture());
  assert.ok(plan.command.outputs.helperCachePath?.endsWith("/helper-cache.jsonl"));
  assert.ok(plan.command.args.includes(`--helper-cache-path=${plan.command.outputs.helperCachePath}`));
});

test("exported source receives the native runtime source declaration without inheriting arbitrary environment", () => {
  const plan = prepareCoworkerAttempt(coworkerAttemptFixture());
  assert.equal(plan.command.environment.inherit, false);
  assert.equal(plan.command.environment.values.PROBING_RUNTIME_SOURCE_SHA, COWORKER_SOURCE_REVISION);
  assert.equal(plan.qualification, "declarations_only"); assert.equal(plan.launchSupported, false);
  assert.deepEqual(Object.keys(plan.command.environment.values).sort(), ["PROBING_RUNTIME_SOURCE_SHA", "PYTHONHASHSEED", "PYTHONNOUSERSITE", "PYTHONPATH"]);
});

test("preview rejects project and operation identities that the ledger cannot admit", () => {
  for (const projectId of ["x".repeat(129), "x".repeat(200)]) {
    const input = coworkerAttemptFixture(); input.run.projectId = projectId;
    assert.throws(() => prepareCoworkerAttempt(input));
  }
  const input = coworkerAttemptFixture(); input.run.projectId = "x".repeat(128);
  assert.equal(prepareCoworkerAttempt(input).binding.projectId, input.run.projectId);
  input.operationRevision = 0; assert.throws(() => prepareCoworkerAttempt(input));
});

test("a declared source path cannot insert another Python import search directory", () => {
  const input = coworkerAttemptFixture(); input.configuration.source.root = "/opt/pinned:/opt/unreviewed";
  assert.throws(() => prepareCoworkerAttempt(rebindCoworkerFixture(input)), /PYTHONPATH/u);
});

test("the pinned shuffled-control path requires exact G4 rather than accepting its unsupported historical G8 domain", () => {
  for (const g of [2, 3, 5, 8]) {
    const input = coworkerAttemptFixture();
    input.configuration.trainer = { ...input.configuration.trainer, g, shuffledControlSeed: 4, shuffledTrainingRunSeed: 11 };
    assert.throws(() => prepareCoworkerAttempt(rebindCoworkerFixture(input)), /4|shuffled/u);
  }
  const input = coworkerAttemptFixture(); input.configuration.trainer = { ...input.configuration.trainer, g: 4, shuffledControlSeed: 4, shuffledTrainingRunSeed: 11 };
  const plan = prepareCoworkerAttempt(rebindCoworkerFixture(input));
  assert.ok(plan.command.args.includes("--g=4"));
  assert.ok(plan.command.args.includes("--shuffled-control-seed=4"));
  assert.ok(plan.command.args.includes("--shuffled-training-run-seed=11"));
});
