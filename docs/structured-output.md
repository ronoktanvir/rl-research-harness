# Structured output for official-client reviewers

The worker can request a JSON object through each official client's schema interface. The research validator still decides whether a review has the right identity, uses existing evidence, covers required criteria and accounts for unresolved objections. A matching JSON shape does not establish scientific validity.

## Client interfaces and qualification

Checked on 2026-11-01 (America/Los_Angeles): installed `codex-cli 0.156.1` advertises `codex exec --output-schema <FILE>`; installed Claude Code `2.1.281` advertises `--json-schema <schema>`. These were read-only version/help checks. This change was tested with injected process responses, without additional model calls.

OpenAI documents `--output-schema` as a request for a final answer conforming to a supplied JSON Schema. Its example uses required fields and `additionalProperties: false`. The harness supplies the schema file and continues reading the final agent message from the JSON event stream. [OpenAI non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode#create-structured-outputs-with-a-schema), [command reference](https://learn.chatgpt.com/docs/developer-commands#codex-exec).

Claude documents `--output-format json --json-schema <schema>` and places the answer in the terminal result's `structured_output` field. That field can be absent, including on refusal; the ordinary `result` field is not a substitute. [Claude Code structured output](https://code.claude.com/docs/en/headless#get-structured-output), [CLI reference](https://code.claude.com/docs/en/cli-reference).

## Contract and bounds

`CliTask.outputSchema?: JsonObject` is optional. Existing callers without a schema retain their prior text-result handling. Before any client invocation, the worker serializes an inert snapshot with a 65,536-byte maximum, at most 4,096 visited values and nesting depth 32. It rejects sparse arrays, accessors, non-JSON values, cycles and nonlocal schema references. The root schema must describe an object. This is a transport check, not a complete validator for every JSON Schema dialect; unsupported schemas remain client errors.

Codex receives an exclusively created `output-schema.json` file with mode `0600` inside the private temporary working directory. Cleanup removes that directory on normal completion, authentication refusal or an exception; abrupt process/host death can leave a temporary directory. Claude receives the serialized schema as one literal argument to a process launched without a shell. Schemas should contain contract metadata, not secrets: command arguments may be visible to processes permitted to inspect them. Prompts continue to use stdin.

`reviewJsonSchema({reviewerId, packetDigest, round})` fixes review identity and defines the existing review fields and enum values. Every record disallows additional fields. `revisionJsonSchema()` permits only `{proposal: string}`. These helpers are used by `runCliCouncil` and the round-zero scheduled reviewer handlers. The controller preserves the question, evidence, checks and criteria during proposal revision. The in-memory council itself is not made durable by this change; durable council orchestration is a separate component.

## Completion and failure meaning

The worker requires a successful terminal protocol record and zero process exit status. Interrupted, nonzero-exit, partial, authentication and quota outcomes retain their existing distinctions. A successful terminal result in schema mode can still contain a missing or malformed answer. Claude's structured value is serialized faithfully into `CliTaskResult.text`; a missing field produces empty text. Codex's final answer text is preserved. The core then records missing/malformed review output separately from provider or execution failure.

There is no Markdown stripping, JSON repair, alternate-field guess, account rotation, backend fallback or harness retry. Shape-compatible fabricated evidence still fails the existing semantic checks. The schema transport does not retroactively validate or recover earlier failed review artifacts; where raw prior output was not retained, its exact failure cause remains unknown.

Offline regression tests cover schema bounds, private file permissions and cleanup, mutation after submission, literal argument handling, terminal structured output, missing/refused answers, partial/failing processes and proposal-only revision rejection. They do not establish end-to-end model compliance with the installed clients' disabled-tool settings or qualify unattended server authentication. A separately authorized bounded client qualification is needed for that evidence.
