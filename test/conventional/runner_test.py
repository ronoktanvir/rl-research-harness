"""Offline protocol/ownership tests. Scripted environments are not Gym trials."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import random
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

RUNNER_PATH = Path(__file__).resolve().parents[2] / "src/integrations/conventional/runner.py"
SPEC = importlib.util.spec_from_file_location("conventional_runner_test_target", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def request():
    return {"schemaVersion": 1, "kind": "frozenlake-q-learning", "requestId": "test-request", "requestDigest": "a" * 64,
            "environment": {"id": "FrozenLake-v1", "mapName": "4x4", "isSlippery": True, "maxEpisodeSteps": 3},
            "algorithm": {"name": "tabular-q-learning", "learningRate": 0.5, "discount": 0.95, "epsilonStart": 1, "epsilonEnd": 0.1},
            "replicates": [{"replicateId": "first", "policySeed": 31, "trainingEpisodeSeeds": [11, 12]}],
            "evaluation": {"episodeSeeds": [101, 102], "randomActionSeeds": [201, 202]},
            "limits": {"maxTransitions": 100, "maxEpisodeTransitions": 2}}


class ScriptedEnvironment:
    def __init__(self, configuration):
        self.horizon = configuration["maxEpisodeSteps"]
        self.seed_log = []
        self.actions = []
        self.closed = False
        self.done = True

    def reset(self, *, seed):
        self.seed_log.append(seed)
        self.step_count = 0
        self.done = False
        return 0, {}

    def step(self, action):
        if self.done:
            raise AssertionError("step after completion")
        self.actions.append(action)
        self.step_count += 1
        self.done = self.step_count == self.horizon
        return 1, 0.0, False, self.done, {}

    def close(self):
        self.closed = True


class RunnerTests(unittest.TestCase):
    def test_request_is_detached_and_budget_covers_every_condition(self):
        raw = request()
        value = runner.validate_request(raw)
        raw["replicates"][0]["trainingEpisodeSeeds"][0] = 99
        self.assertEqual(value["replicates"][0]["trainingEpisodeSeeds"][0], 11)
        value["limits"]["maxTransitions"] = 11  # 2 train + 2 eval + 2 baseline, each <=2.
        with self.assertRaises(runner.InvalidRequest):
            runner.validate_request(value)
        value["limits"]["maxTransitions"] = 12
        runner.validate_request(value)

    def test_strict_shapes_ranges_and_seed_partitions(self):
        patches = [lambda q: q.update(extra=True), lambda q: q.update(schemaVersion=True),
                   lambda q: q["environment"].update(isSlippery=1), lambda q: q["environment"].update(mapName="8x8"),
                   lambda q: q["algorithm"].update(discount=True), lambda q: q["algorithm"].update(learningRate=0),
                   lambda q: q["algorithm"].update(epsilonEnd=2), lambda q: q["algorithm"].update(discount=10**500),
                   lambda q: q["limits"].update(maxTransitions=1_000_001),
                   lambda q: q["replicates"][0].update(trainingEpisodeSeeds=[11, 11]),
                   lambda q: q["replicates"][0].update(policySeed=11),
                   lambda q: q["evaluation"].update(episodeSeeds=[11, 102]),
                   lambda q: q["evaluation"].update(randomActionSeeds=[101, 202]),
                   lambda q: q["evaluation"].update(randomActionSeeds=[201]),
                   lambda q: q["replicates"].append(copy.deepcopy(q["replicates"][0]))]
        for patch in patches:
            with self.subTest(patch=patch):
                value = request()
                patch(value)
                with self.assertRaises(runner.InvalidRequest):
                    runner.validate_request(value)

    def test_json_parser_rejects_duplicates_nonfinite_trailing_data_and_oversize(self):
        source = json.dumps(request()).encode()
        self.assertEqual(runner.parse_request(source)["requestId"], "test-request")
        for value in (source.replace(b'"schemaVersion": 1', b'"schemaVersion": 1, "schemaVersion": 1'),
                      source.replace(b'"discount": 0.95', b'"discount": NaN'),
                      source + b"{}", b" " * (runner.MAX_INPUT_BYTES + 1), b"\xff"):
            with self.subTest(value=value[:80]):
                with self.assertRaises((ValueError, UnicodeError)):
                    runner.parse_request(value)

    def test_one_baseline_is_shared_and_all_factories_close(self):
        value = request()
        value["replicates"].append({"replicateId": "second", "policySeed": 32, "trainingEpisodeSeeds": [21, 22]})
        environments = []
        def factory(configuration):
            env = ScriptedEnvironment(configuration)
            environments.append(env)
            return env
        result = runner.execute(value, make_env=factory, versions={"python": "fixture", "gymnasium": "fixture", "numpy": "fixture"})
        self.assertEqual(len(environments), 5)  # One baseline, training/evaluation for each table.
        self.assertTrue(all(env.closed for env in environments))
        self.assertEqual([env.seed_log for env in environments], [[101, 102], [11, 12], [101, 102], [21, 22], [101, 102]])
        self.assertEqual(result["totalTransitions"], 20)
        self.assertEqual(result["randomBaseline"]["summary"]["episodes"], 2)
        self.assertEqual(result["randomBaseline"]["summary"]["successes"], 0)
        self.assertFalse(result["resumeSupported"])
        for replica in result["replicates"]:
            self.assertEqual(replica["evaluation"]["baseline"], "shared-random-policy")
            self.assertEqual(replica["qTable"], [[0.0] * 4 for _ in range(16)])
            self.assertEqual(replica["greedyActions"], [0] * 16)
            self.assertEqual(replica["evaluation"]["summary"]["harnessCutoffs"], 2)
            self.assertTrue(all(item["actionSeed"] is None for item in replica["evaluation"]["episodes"]))
        self.assertNotIn("solved", json.dumps(result))

    def test_factory_resource_is_closed_on_bad_transition(self):
        env = ScriptedEnvironment({"maxEpisodeSteps": 3})
        env.step = lambda _action: (1, 1, False, False, {})  # Reward on a non-goal state.
        with self.assertRaises(runner.InvalidTransition):
            runner.execute(request(), make_env=lambda _: env, versions={})
        self.assertTrue(env.closed)

    def test_exploration_stream_is_separate_from_reset_stream_and_repeatable(self):
        def actions(seed):
            env = ScriptedEnvironment({"maxEpisodeSteps": 50})
            runner.episode(env, [[0.0] * 4 for _ in range(16)], episode_index=0, reset_seed=11,
                           action_seed=seed, policy="train", rng=random.Random(seed), epsilon=1,
                           collector_cap=40, environment_cap=50)
            self.assertEqual(env.seed_log, [11])
            return env.actions
        self.assertEqual(actions(31), actions(31))
        self.assertNotEqual(actions(31), actions(32))

    def test_epsilon_schedule_includes_both_endpoints_and_handles_one_episode(self):
        self.assertEqual(runner.epsilon_at(0.8, 0.1, 0, 1), 0.8)
        self.assertEqual(runner.epsilon_at(0.8, 0.1, 0, 4), 0.8)
        self.assertAlmostEqual(runner.epsilon_at(0.8, 0.1, 3, 4), 0.1)

    def test_real_process_rejects_invalid_input_before_optional_imports(self):
        completed = subprocess.run([sys.executable, "-I", "-B", str(RUNNER_PATH)], input=b'{"schemaVersion":true}',
                                   capture_output=True, timeout=3, env={})
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, b"")
        self.assertEqual(completed.stderr, b"conventional runner: invalid request\n")

    def test_version_mismatch_cannot_create_environment_or_emit_result(self):
        for python_minor, gym_version, numpy_version in [((3, 12), "1.4.0", "2.3.5"),
                                                         ((3, 11), "1.3.0", "2.3.5"),
                                                         ((3, 11), "1.4.0", "2.4.0")]:
            with self.subTest(python=python_minor, gym=gym_version, numpy=numpy_version):
                called = []
                gym = types.ModuleType("gymnasium")
                gym.__version__ = gym_version
                gym.make = lambda *_args, **_kwargs: called.append(True)
                numpy = types.ModuleType("numpy")
                numpy.__version__ = numpy_version
                stdin = io.TextIOWrapper(io.BytesIO(json.dumps(request()).encode()))
                stdout = io.TextIOWrapper(io.BytesIO())
                stderr = io.StringIO()
                with patch.dict(sys.modules, {"gymnasium": gym, "numpy": numpy}), \
                        patch.object(sys, "version_info", python_minor), patch.object(sys, "stdin", stdin), \
                        patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
                    status = runner.main()
                self.assertEqual(status, 1)
                self.assertEqual(called, [])
                self.assertEqual(stdout.buffer.getvalue(), b"")
                self.assertEqual(stderr.getvalue(), "conventional runner: execution failed; no complete result\n")


if __name__ == "__main__":
    unittest.main()
