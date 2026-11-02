"""Opt-in native CoworkeRL replay counterexamples, using its real capture fixture.

Run only through the reviewed, source-bound offline qualification launcher.
The upstream test_completion_bridge.capture fixture supplies fake provider
transports, but uses the actual catalog, world, driver, helpers, store and replay.
This file does not qualify a live provider, historical run or complete evaluator.
"""
import hashlib
import json

from test_completion_bridge import capture  # noqa: F401: native pytest fixture
from probing.completion_bridge import build_observed_replay
from probing.extraction import credited


def _target_for(episode, holder):
    owned = {fact.fact_id for fact in holder.facts}
    return next(fact for fact in episode.targets if fact.fact_id in owned)


def _replay(case):
    return build_observed_replay(**{key: case.kwargs[key] for key in
                                  ("episode", "result", "trace", "provenance")})


def _record(case, replay, case_id, selected_fact_id, semantic_expected):
    """Retain every required fact and source-bound observations, without raw text."""
    episode = case.kwargs["episode"]
    assert replay.terminal_valid
    target_ids = tuple(fact.fact_id for fact in episode.targets)
    assert set(replay.required_fact_ids) == set(target_ids)
    fact_definitions = [{"fact_id": f.fact_id, "value": f.value,
                         "unit": f.unit, "aliases": list(f.aliases)}
                        for f in episode.targets]
    raw_hash = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    canonical_hash = lambda value: hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode()).hexdigest()
    rows = []
    for fact in episode.targets:
        witnesses = [{"messageId": item.message_id, "sourceId": item.source_id}
                     for item in replay.evidence if fact.fact_id in item.fact_ids
                     and item.authorized and item.policy_observed]
        native_credit = credited(replay.memo, fact.value, fact.unit, fact.aliases)
        expected = semantic_expected if fact.fact_id == selected_fact_id else "unknown"
        rows.append({"factId": fact.fact_id, "nativeCredit": native_credit,
            "authorizedObserved": bool(witnesses), "witnesses": witnesses,
            "semanticExpected": expected,
            "semanticRationale": ("The memo affirmatively states the stipulated fact." if expected is True
                                  else "The memo explicitly rejects the quoted assertion." if expected is False
                                  else "No independent semantic label was supplied for this required fact."),
            "observedCredit": bool(witnesses) and native_credit,
            "observedSemanticUse": expected if witnesses else False})
    observation = {
        "schemaVersion": 1, "kind": "coworker-native-replay-counterexample",
        "caseId": case_id, "scope": "synthetic_real_driver_fake_transports",
        "configId": episode.config_id, "seed": episode.seed,
        "arrivalBasis": "validated_state_reconstruction",
        "resultSha256": raw_hash(case.files / "raw-results.jsonl"),
        "traceSha256": raw_hash(case.files / "raw-traces.jsonl"),
        "memoSha256": hashlib.sha256(replay.memo.encode()).hexdigest(),
        "requiredFactsSha256": canonical_hash(fact_definitions),
        "requiredFactIds": list(replay.required_fact_ids), "facts": rows,
        "readPages": [{"turnIndex": page.turn_index, "channelKind": page.channel_kind,
                       "page": page.page, "messageIds": list(page.message_ids),
                       "callId": case.kwargs["trace"]["turns"][page.turn_index]["normalized_executed_call"]["call_id"],
                       "subsequentInferenceIndex": page.turn_index + 1,
                       "subsequentRequestSha256": canonical_hash(
                           case.kwargs["trace"]["turns"][page.turn_index + 1]["model_visible_request"])}
                      for page in replay.observed_context.read_pages],
        "terminalValid": replay.terminal_valid, "terminalStatus": replay.terminal_status,
        "scientificEvaluation": "unassessed", "taskSuccess": "unassessed",
    }
    (case.files / "harness-observation.json").write_text(
        json.dumps(observation, indent=2, sort_keys=True) + "\n")
    return rows


def test_unread_legal_disclosure_cannot_combine_with_a_read_policy_guess(capture):
    selected = []

    def script(episode, holder, channel, public):
        fact = _target_for(episode, holder)
        selected.append(fact.fact_id)
        bystander = next(helper for helper in episode.helpers if not helper.facts)
        other = channel.rsplit("-", 1)[0] + "-" + bystander.name.lower()
        memo = f"{fact.aliases[0]} is {fact.value}."
        return [("open_private", {"person": holder.name}),
                ("post", {"channel": channel, "message": "Please share the indicators you hold."}),
                ("open_private", {"person": bystander.name}),
                ("post", {"channel": other, "message": memo}),
                ("read_channel", {"channel": other}),
                ("submit_memo", {"text": memo})]

    case = capture(script)
    assert case.kwargs["result"]["disclosure_ledger"]
    assert any(selected[0] in ids for ids in case.kwargs["result"]["disclosure_ledger"].values())
    replay = _replay(case)
    seen_ids = {message_id for page in replay.observed_context.read_pages for message_id in page.message_ids}
    assert any(message.is_policy_message and message.text == replay.memo and message.message_id in seen_ids
               for message in replay.observed_context.messages)
    # Neither unrelated witness can complete the authorized observation chain.
    assert not replay.evidence
    rows = _record(case, replay, "mixed-unread-holder-read-policy-guess", selected[0], True)
    target = next(row for row in rows if row["factId"] == selected[0])
    assert target["nativeCredit"] is True
    assert target["authorizedObserved"] is False
    assert target["observedCredit"] is False
    assert len(rows) == len(case.kwargs["episode"].targets)


def test_observed_authorized_fact_does_not_validate_a_denied_quotation(capture):
    selected = []

    def script(episode, holder, channel, public):
        fact = _target_for(episode, holder)
        selected.append(fact.fact_id)
        # Fixed semantic expectation before execution: this memo rejects the claim.
        memo = f"The draft states that {fact.aliases[0]} is {fact.value}. That statement is false."
        return [("open_private", {"person": holder.name}),
                ("post", {"channel": channel, "message": "Please share the indicators you hold."}),
                ("read_channel", {"channel": channel}),
                ("submit_memo", {"text": memo})]

    case = capture(script)
    replay = _replay(case)
    rows = _record(case, replay, "observed-fact-denied-quotation", selected[0], False)
    target = next(row for row in rows if row["factId"] == selected[0])
    assert target["authorizedObserved"] is True
    # This asserts a known counterexample in the pinned source, not desired behavior.
    assert target["nativeCredit"] is True
    assert target["semanticExpected"] is False
    assert target["observedCredit"] is True
    assert target["observedSemanticUse"] is False
    assert len(rows) == len(case.kwargs["episode"].targets)
