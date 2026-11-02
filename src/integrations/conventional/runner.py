"""Bounded FrozenLake experiment worker; JSON stdin/stdout, no artifact writes.

Only main's real environment factory imports Gymnasium. Unit tests inject inert
environments. This process does not admit work, attest deployment, or resume it.
Termination masks bootstrapping; external truncation/collector cutoffs do not:
https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/
"""

from __future__ import annotations

import json
import math
import platform
import random
import re
import sys
from typing import Any, Callable

MAX_INPUT_BYTES = 131_072
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_EPISODE_RECORDS = 12_000
EXPECTED_GYMNASIUM = "1.4.0"
EXPECTED_NUMPY = "2.3.5"
EXPECTED_PYTHON = (3, 11)
MAP = ("SFFF", "FHFH", "FFFH", "HFFG")
HOLES = frozenset((5, 7, 11, 12))
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
DIGEST = re.compile(r"[a-f0-9]{64}\Z")


class InvalidRequest(ValueError):
    pass


class InvalidTransition(ValueError):
    pass


def _keys(value: Any, expected: set[str]) -> None:
    if type(value) is not dict or set(value) != expected:
        raise InvalidRequest("unexpected object fields")


def _integer(value: Any, minimum: int, maximum: int) -> None:
    if type(value) is not int or not minimum <= value <= maximum:
        raise InvalidRequest("integer outside allowed range")


def _number(value: Any, minimum: float, maximum: float, *, positive=False) -> None:
    if type(value) not in (int, float) or not minimum <= value <= maximum or not math.isfinite(value) or positive and value <= 0:
        raise InvalidRequest("number outside allowed range")


def _seeds(value: Any, maximum: int) -> None:
    if type(value) is not list or not 1 <= len(value) <= maximum:
        raise InvalidRequest("invalid seed array")
    for seed in value:
        _integer(seed, 0, 2**32 - 1)
    if len(set(value)) != len(value):
        raise InvalidRequest("duplicate seeds")


def validate_request(raw: Any) -> dict[str, Any]:
    """Validate before importing scientific dependencies or creating environments."""
    _keys(raw, {"schemaVersion", "kind", "requestId", "requestDigest", "environment", "algorithm", "replicates", "evaluation", "limits"})
    if type(raw["schemaVersion"]) is not int or raw["schemaVersion"] != 1 or raw["kind"] != "frozenlake-q-learning":
        raise InvalidRequest("unsupported protocol")
    if type(raw["requestId"]) is not str or not ID.fullmatch(raw["requestId"]):
        raise InvalidRequest("invalid request identity")
    if type(raw["requestDigest"]) is not str or not DIGEST.fullmatch(raw["requestDigest"]):
        raise InvalidRequest("invalid request digest")
    environment, algorithm, limits = raw["environment"], raw["algorithm"], raw["limits"]
    _keys(environment, {"id", "mapName", "isSlippery", "maxEpisodeSteps"})
    if environment["id"] != "FrozenLake-v1" or environment["mapName"] != "4x4" or type(environment["isSlippery"]) is not bool:
        raise InvalidRequest("unsupported environment")
    _integer(environment["maxEpisodeSteps"], 1, 100)
    _keys(algorithm, {"name", "learningRate", "discount", "epsilonStart", "epsilonEnd"})
    if algorithm["name"] != "tabular-q-learning":
        raise InvalidRequest("unsupported algorithm")
    _number(algorithm["learningRate"], 0, 1, positive=True)
    _number(algorithm["discount"], 0, 1)
    _number(algorithm["epsilonStart"], 0, 1)
    _number(algorithm["epsilonEnd"], 0, algorithm["epsilonStart"])
    _keys(limits, {"maxTransitions", "maxEpisodeTransitions"})
    _integer(limits["maxTransitions"], 1, 1_000_000)
    _integer(limits["maxEpisodeTransitions"], 1, 100)
    evaluation = raw["evaluation"]
    _keys(evaluation, {"episodeSeeds", "randomActionSeeds"})
    _seeds(evaluation["episodeSeeds"], 1000)
    _seeds(evaluation["randomActionSeeds"], 1000)
    if len(evaluation["episodeSeeds"]) != len(evaluation["randomActionSeeds"]):
        raise InvalidRequest("evaluation/action seeds must align")
    replicates = raw["replicates"]
    if type(replicates) is not list or not 1 <= len(replicates) <= 8:
        raise InvalidRequest("invalid replica count")
    ids: set[str] = set()
    # Distinct stream seeds do not prove statistical independence, but avoid the
    # accidental identical action/transition stream created by reusing a seed.
    occupied = set(evaluation["episodeSeeds"])
    action_seeds = set(evaluation["randomActionSeeds"])
    if occupied & action_seeds:
        raise InvalidRequest("action and environment seeds must be distinct")
    occupied |= action_seeds
    records = (len(replicates) + 1) * len(evaluation["episodeSeeds"])
    for replica in replicates:
        _keys(replica, {"replicateId", "policySeed", "trainingEpisodeSeeds"})
        identifier = replica["replicateId"]
        if type(identifier) is not str or not ID.fullmatch(identifier) or identifier in ids:
            raise InvalidRequest("invalid or duplicate replica identity")
        ids.add(identifier)
        _integer(replica["policySeed"], 0, 2**32 - 1)
        _seeds(replica["trainingEpisodeSeeds"], 2000)
        seeds = {replica["policySeed"], *replica["trainingEpisodeSeeds"]}
        if len(seeds) != len(replica["trainingEpisodeSeeds"]) + 1 or seeds & occupied:
            raise InvalidRequest("replica, action, and evaluation seed sets overlap")
        occupied |= seeds
        records += len(replica["trainingEpisodeSeeds"])
    if records > MAX_EPISODE_RECORDS:
        raise InvalidRequest("episode output bound exceeded")
    worst_case = records * min(environment["maxEpisodeSteps"], limits["maxEpisodeTransitions"])
    if worst_case > limits["maxTransitions"]:
        raise InvalidRequest("declared transition allowance cannot cover worst case")
    encoded = json.dumps(raw, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_INPUT_BYTES:
        raise InvalidRequest("request byte bound exceeded")
    return json.loads(encoded)


def epsilon_at(start: float, end: float, episode_index: int, episodes: int) -> float:
    return float(start if episodes == 1 else start + (end - start) * episode_index / (episodes - 1))


def update_q(table: list[list[float]], state: int, action: int, reward: float,
             next_state: int, terminated: bool, learning_rate: float, discount: float) -> None:
    target = reward if terminated else reward + discount * max(table[next_state])
    table[state][action] += learning_rate * (target - table[state][action])
    if not math.isfinite(table[state][action]):
        raise InvalidTransition("nonfinite learned value")


def _state(value: Any) -> int:
    # Gymnasium may use numpy integer scalars. Reject booleans and nonintegral
    # values without importing NumPy at module import time.
    if isinstance(value, bool) or not hasattr(value, "__index__"):
        raise InvalidTransition("invalid discrete observation")
    result = int(value.__index__())
    if not 0 <= result < 16:
        raise InvalidTransition("observation outside fixed map")
    return result


def episode(env: Any, table: Any, *, episode_index: int, reset_seed: int,
            action_seed: int | None, policy: str, rng: random.Random | None,
            epsilon: float, collector_cap: int, environment_cap: int,
            learning_rate: float = 0, discount: float = 0) -> dict[str, Any]:
    """Collect one episode; never step after either done flag or our cutoff.

    Training RNG spans episodes of one replica. Random-baseline RNG is reset to
    its explicit per-episode seed. Greedy evaluation has no RNG or table writes.
    """
    state = _state(env.reset(seed=reset_seed)[0])
    if state != 0:
        raise InvalidTransition("FrozenLake did not reset at the declared start")
    if policy not in ("train", "greedy", "random") or (policy != "greedy" and rng is None):
        raise ValueError("invalid internal policy")
    total = 0.0
    for step_count in range(1, collector_cap + 1):
        if policy == "random" or policy == "train" and rng.random() < epsilon:
            action = rng.randrange(4)
        else:
            best = max(table[state])
            choices = [index for index, value in enumerate(table[state]) if value == best]
            action = choices[0] if policy == "greedy" else rng.choice(choices)
        next_value, reward_value, terminated, truncated, _info = env.step(action)
        next_state = _state(next_value)
        if type(terminated) is not bool or type(truncated) is not bool:
            raise InvalidTransition("nonboolean episode end flags")
        if isinstance(reward_value, bool) or not isinstance(reward_value, (int, float)) or not math.isfinite(reward_value):
            raise InvalidTransition("invalid reward")
        reward = float(reward_value)
        expected_terminal = next_state == 15 or next_state in HOLES
        if terminated != expected_terminal or reward != (1.0 if next_state == 15 else 0.0):
            raise InvalidTransition("reward/termination disagrees with fixed goal and holes")
        if truncated != (step_count >= environment_cap):
            raise InvalidTransition("time-limit flag disagrees with configured wrapper")
        if policy == "train":
            update_q(table, state, action, reward, next_state, terminated, learning_rate, discount)
        total += reward
        harness_cutoff = step_count == collector_cap and not (terminated or truncated)
        if terminated or truncated or harness_cutoff:
            return {"episodeIndex": episode_index, "resetSeed": reset_seed, "actionSeed": action_seed,
                    "return": total, "steps": step_count, "finalState": next_state,
                    "terminated": terminated, "truncated": truncated, "harnessCutoff": harness_cutoff,
                    "success": terminated and next_state == 15}
        state = next_state
    raise AssertionError("collector did not finish")


def summarize(episodes: list[dict[str, Any]]) -> dict[str, Any]:
    return {"episodes": len(episodes), "successes": sum(item["success"] for item in episodes),
            "successRate": sum(item["success"] for item in episodes) / len(episodes),
            "meanReturn": sum(item["return"] for item in episodes) / len(episodes),
            "totalTransitions": sum(item["steps"] for item in episodes),
            "terminated": sum(item["terminated"] for item in episodes),
            "truncated": sum(item["truncated"] for item in episodes),
            "harnessCutoffs": sum(item["harnessCutoff"] for item in episodes)}


def execute(raw: Any, *, make_env: Callable[[dict[str, Any]], Any], versions: dict[str, str]) -> dict[str, Any]:
    """Run only a validated bounded request using an explicitly supplied factory."""
    request = validate_request(raw)
    environment, algorithm = request["environment"], request["algorithm"]
    cap = request["limits"]["maxEpisodeTransitions"]
    env_cap = environment["maxEpisodeSteps"]

    def collect(table, *, policy, seeds, action_seeds, rng=None):
        env = make_env(environment)
        try:
            result = []
            for index, seed in enumerate(seeds):
                action_seed = action_seeds[index]
                active_rng = random.Random(action_seed) if policy == "random" else rng
                epsilon = epsilon_at(algorithm["epsilonStart"], algorithm["epsilonEnd"], index, len(seeds)) if policy == "train" else 0.0
                result.append(episode(env, table, episode_index=index, reset_seed=seed, action_seed=action_seed,
                                      policy=policy, rng=active_rng, epsilon=epsilon, collector_cap=cap,
                                      environment_cap=env_cap, learning_rate=algorithm["learningRate"], discount=algorithm["discount"]))
            return {"episodes": result, "summary": summarize(result)}
        finally:
            env.close()

    eval_seeds = request["evaluation"]["episodeSeeds"]
    # One shared baseline measurement. It is not R independent measurements just
    # because R learned policies are compared with it.
    baseline = collect(None, policy="random", seeds=eval_seeds, action_seeds=request["evaluation"]["randomActionSeeds"])
    replicas = []
    for replica in request["replicates"]:
        table = [[0.0] * 4 for _ in range(16)]
        training = collect(table, policy="train", seeds=replica["trainingEpisodeSeeds"],
                           action_seeds=[replica["policySeed"]] * len(replica["trainingEpisodeSeeds"]), rng=random.Random(replica["policySeed"]))
        frozen = tuple(tuple(row) for row in table)
        evaluation = collect(frozen, policy="greedy", seeds=eval_seeds, action_seeds=[None] * len(eval_seeds))
        replicas.append({"replicateId": replica["replicateId"], "policySeed": replica["policySeed"], "training": training,
                         "qTable": [list(row) for row in frozen], "greedyActions": [row.index(max(row)) for row in frozen],
                         "evaluation": {**evaluation, "baseline": "shared-random-policy"}})
    transitions = baseline["summary"]["totalTransitions"] + sum(item[phase]["summary"]["totalTransitions"] for item in replicas for phase in ("training", "evaluation"))
    if transitions > request["limits"]["maxTransitions"]:
        raise InvalidTransition("transition allowance exceeded")
    return {"schemaVersion": 1, "kind": "frozenlake-q-learning-result", "requestId": request["requestId"],
            "requestDigest": request["requestDigest"], "environment": {**environment, "map": list(MAP), "rewardSchedule": [1, 0, 0], "slipSuccessRate": 1 / 3},
            "algorithm": {**algorithm, "epsilonSchedule": "linear_per_episode_start_to_end_single_episode_uses_start",
                          "policyRng": "python.random.Random/MT19937", "trainingActionStream": "replicate_continuous",
                          "randomBaselineActionStream": "per_episode", "trainingTieBreak": "seeded_uniform_argmax", "evaluationTieBreak": "lowest_action_index",
                          "bootstrapMask": "not_terminated", "evaluationUpdates": False},
            "versions": dict(versions), "randomBaseline": baseline, "replicates": replicas,
            "totalTransitions": transitions, "resumeSupported": False}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidRequest("duplicate JSON key")
        result[key] = value
    return result


def parse_request(payload: bytes) -> dict[str, Any]:
    if len(payload) > MAX_INPUT_BYTES:
        raise InvalidRequest("request byte bound exceeded")
    def reject_constant(_value):
        raise InvalidRequest("nonfinite JSON constant")
    return validate_request(json.loads(payload.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=reject_constant))


def main() -> int:
    try:
        request = parse_request(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1))
    except (ValueError, TypeError, OverflowError, RecursionError):
        sys.stderr.write("conventional runner: invalid request\n")
        return 2
    try:
        if sys.version_info[:2] != EXPECTED_PYTHON:
            raise RuntimeError("unsupported Python minor version")
        import gymnasium as gym
        import numpy as np
        if gym.__version__ != EXPECTED_GYMNASIUM or np.__version__ != EXPECTED_NUMPY:
            raise RuntimeError("scientific dependency version mismatch")

        def make_env(configuration):
            env = gym.make("FrozenLake-v1", map_name="4x4", is_slippery=configuration["isSlippery"],
                           success_rate=1 / 3, reward_schedule=(1, 0, 0),
                           max_episode_steps=configuration["maxEpisodeSteps"], render_mode=None)
            try:
                observed_map = [b"".join(row).decode("ascii") for row in env.unwrapped.desc]
                if observed_map != list(MAP) or env.observation_space.n != 16 or env.action_space.n != 4:
                    raise InvalidTransition("installed environment differs from declared map/spaces")
                return env
            except BaseException:
                env.close()
                raise

        result = execute(request, make_env=make_env, versions={"python": platform.python_version(), "gymnasium": gym.__version__, "numpy": np.__version__})
        output = json.dumps(result, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
        if len(output) > MAX_OUTPUT_BYTES:
            raise InvalidTransition("result byte bound exceeded")
        sys.stdout.buffer.write(output)
        return 0
    except Exception:
        # Keep traceback paths, exception payloads and dependency diagnostics out
        # of the machine-readable result. The controller records nonzero exit.
        sys.stderr.write("conventional runner: execution failed; no complete result\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
