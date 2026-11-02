# Paused checkpoint — 2026-11-02 UTC

The user requested a temporary pause while walking home without Wi-Fi. Resume only when the user resumes the task. The full harness objective remains incomplete.

## Completed and verified

- Supervised conventional RL planning, deployment resolution, atomic child output and exact journal/artifact collection are implemented and independently reviewed.
- Publisher PDF retrieval, bounded Linux page extraction, CLI commands and source provenance are implemented and independently reviewed.
- Final local verification: TypeScript check passed; 471 Node tests passed, zero failed, four explicit native skips; 26 Python tests passed; diff check passed.
- All three subagents finished. No local services, training job or model request is running.
- One actual publisher PDF was retrieved and reloaded offline; see `docs/research/publisher-qualification-2026-11-02.md`. The new native parser has not processed that PDF.
- The two-unit live official-client allowance remains consumed. No additional live model call is authorized by this checkpoint. The existing arXiv hold remains active and must not be bypassed or released without evidence.

## Next concrete work

1. Publish the local reviewed commits to the existing private repository. The previously published HEAD was `96de155b16fbe893499c360a1c48eed7c0ba3b97`.
2. Apply the planned CI change using the GitHub connector: `gh` has no workflow scope. The intended complete workflow is saved in ignored `.harness/ci-planned.yml`; re-fetch `.github/workflows/ci.yml` and its current blob SHA before updating. Do not blindly overwrite intervening changes.
3. The planned workflow creates a copied Python 3.11 venv at `/tmp/rlh-conventional-venv`, outside systemd's hidden `/home`, and enables `test/conventional/supervised-linux.test.ts` only in the isolated CI fixture. It adds a Python 3.12/pypdf6.10.0 job for `test/literature/pdf-native.test.ts`. No services or Docker runs on the local Mac.
4. Inspect actual CI job outcomes/logs for the exact source revision. Fix substantive failures, then update qualification/status/context. Native success is currently **pending**, not established by the offline tests.
5. Continue toward CoworkerRL deployment/input closure, completion of evidence requests, protected scientific evaluation and autonomous campaign selection. Full-paper text extraction does not constitute claim review.

## Important local artifacts

The authoritative local stores are ignored `.harness/coworker.sqlite` and `.harness/research-queue.sqlite`; the saved controller configuration is `.harness/controller.json`. Never commit these, the private PDFs, dependency environments or credentials. The final local Node log is `.harness/current-tests.log`. The live publisher request/result are `.harness/publisher-qualification-request.json` and `.harness/publisher-qualification-result.json`.

The native tests are already committed as opt-in fixtures but were skipped locally. Do not make additional publisher/arXiv/model calls merely to repeat completed qualification. No Droplet or CoworkerRL campaign has been deployed or started.
