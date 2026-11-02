"""Independent methods regressions using only scripted inert environments.

These tests do not import Gymnasium, install dependencies or run the real task.
"""

import copy
import importlib.util
import json
from pathlib import Path
import random
import unittest


SPEC = importlib.util.spec_from_file_location(
    "conventional_runner_review",
    Path(__file__).resolve().parents[2] / "src/integrations/conventional/runner.py",
)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ScriptedEnv:
    def __init__(self, transitions):
        self.transitions = transitions
        self.resets = []
        self.actions = []
        self.position = 0
        self.closed = False

    @property
    def action_space(self):
        raise AssertionError("action sampling must use its independent policy RNG")

    def reset(self, *, seed):
        self.resets.append(seed)
        self.position = 0
        return 0, {}

    def step(self, action):
        self.actions.append(action)
        if self.position >= len(self.transitions):
            raise AssertionError("stepped after episode completion")
        transition = self.transitions[self.position]
        self.position += 1
        return (*transition, {})

    def close(self):
        self.closed = True


def table():
    return [[0.0] * 4 for _ in range(16)]


def collect(env, q, *, policy="train", collector_cap=1, environment_cap=1,
            rng_seed=17, epsilon=0.0):
    return runner.episode(
        env, q, episode_index=0, reset_seed=50,
        action_seed=rng_seed if policy != "greedy" else None,
        policy=policy, rng=random.Random(rng_seed) if policy != "greedy" else None,
        epsilon=epsilon, collector_cap=collector_cap, environment_cap=environment_cap,
        learning_rate=1.0, discount=0.9,
    )


def request():
    return {
        "schemaVersion": 1, "kind": "frozenlake-q-learning",
        "requestId": "method-fixture", "requestDigest": "a" * 64,
        "environment": {"id": "FrozenLake-v1", "mapName": "4x4", "isSlippery": True, "maxEpisodeSteps": 1},
        "algorithm": {"name": "tabular-q-learning", "learningRate": 0.5,
                      "discount": 0.9, "epsilonStart": 1.0, "epsilonEnd": 0.1},
        "replicates": [
            {"replicateId": "one", "policySeed": 101, "trainingEpisodeSeeds": [1]},
            {"replicateId": "two", "policySeed": 102, "trainingEpisodeSeeds": [2]},
        ],
        "evaluation": {"episodeSeeds": [201, 202], "randomActionSeeds": [301, 302]},
        "limits": {"maxTransitions": 8, "maxEpisodeTransitions": 1},
    }


class IndependentMethodsTests(unittest.TestCase):
    def test_terminal_target_discards_future_value_while_external_end_bootstraps(self):
        q = table()
        q[15] = [100.0] * 4
        runner.update_q(q, 0, 0, 1.0, 15, True, 1.0, 0.9)
        self.assertEqual(q[0][0], 1.0)
        q[1] = [8.0] * 4
        runner.update_q(q, 0, 0, 0.0, 1, False, 1.0, 0.9)
        self.assertAlmostEqual(q[0][0], 7.2)

    def test_goal_at_wrapper_horizon_preserves_both_flags_and_success(self):
        q = table()
        q[15] = [100.0] * 4
        env = ScriptedEnv([(15, 1.0, True, True)])
        result = collect(env, q)
        self.assertTrue(result["terminated"])
        self.assertTrue(result["truncated"])
        self.assertTrue(result["success"])
        self.assertFalse(result["harnessCutoff"])
        self.assertEqual(sum(q[0]), 1.0)
        self.assertEqual(len(env.actions), 1)

    def test_truncation_uses_last_observation_not_reset_state(self):
        q = table()
        q[0][0] = 1.0
        q[1] = [8.0] * 4
        env = ScriptedEnv([(1, 0.0, False, True)])
        result = collect(env, q)
        self.assertAlmostEqual(q[0][0], 7.2)
        self.assertEqual(result["finalState"], 1)
        self.assertEqual(env.resets, [50])
        self.assertEqual(env.actions, [0])
        self.assertTrue(result["truncated"])
        self.assertFalse(result["terminated"])

    def test_collector_cutoff_is_not_an_invented_environment_truncation(self):
        q = table()
        q[0][0] = 1.0
        q[1] = [8.0] * 4
        result = collect(ScriptedEnv([(1, 0.0, False, False)]), q, environment_cap=3)
        self.assertAlmostEqual(q[0][0], 7.2)
        self.assertTrue(result["harnessCutoff"])
        self.assertFalse(result["truncated"])
        self.assertFalse(result["terminated"])

    def test_greedy_evaluation_has_fixed_ties_and_cannot_mutate_immutable_table(self):
        q = table()
        q[0] = [0.0, 0.0, 2.0, 2.0]
        frozen = tuple(tuple(row) for row in q)
        before = json.dumps(frozen)
        env = ScriptedEnv([(15, 1.0, True, True)])
        result = collect(env, frozen, policy="greedy")
        self.assertEqual(env.actions, [2])
        self.assertTrue(result["success"])
        self.assertEqual(json.dumps(frozen), before)

    def test_reward_success_and_terminal_semantics_are_checked_separately(self):
        for transition in [(15, 0.0, True, True), (1, 1.0, False, True), (5, 0.0, False, True)]:
            with self.subTest(transition=transition):
                with self.assertRaises(runner.InvalidTransition):
                    collect(ScriptedEnv([transition]), table())
        with self.assertRaises(runner.InvalidTransition):
            collect(ScriptedEnv([(0, 0.0, False, False)]), table())

    def test_action_rng_remains_separate_from_environment_and_unseeded_action_space(self):
        actions = []
        for seed in [0, 1]:
            env = ScriptedEnv([(0, 0.0, False, True)])
            collect(env, table(), rng_seed=seed, epsilon=1.0)
            expected = random.Random(seed)
            expected.random()
            self.assertEqual(env.actions, [expected.randrange(4)])
            self.assertEqual(env.resets, [50])
            actions.append(env.actions)
        self.assertNotEqual(actions[0], actions[1])

    def test_single_training_episode_uses_explicit_start_epsilon(self):
        self.assertEqual(runner.epsilon_at(0.8, 0.1, 0, 1), 0.8)
        self.assertEqual(runner.epsilon_at(0.8, 0.1, 0, 3), 0.8)
        self.assertAlmostEqual(runner.epsilon_at(0.8, 0.1, 2, 3), 0.1)

    def test_all_zero_result_retains_training_replicas_and_one_shared_baseline(self):
        environments = []

        def factory(_configuration):
            env = ScriptedEnv([(0, 0.0, False, True)])
            environments.append(env)
            return env

        raw = request()
        original = copy.deepcopy(raw)
        result = runner.execute(raw, make_env=factory,
                                versions={"python": "fixture", "gymnasium": "not-imported", "numpy": "not-imported"})
        self.assertEqual(raw, original)
        self.assertEqual(len(environments), 5)  # baseline, then train/eval for each of two replicas
        self.assertTrue(all(env.closed for env in environments))
        self.assertEqual(result["randomBaseline"]["summary"]["episodes"], 2)
        self.assertEqual(result["totalTransitions"], 8)
        self.assertEqual([item["replicateId"] for item in result["replicates"]], ["one", "two"])
        for replica in result["replicates"]:
            self.assertEqual(replica["evaluation"]["baseline"], "shared-random-policy")
            self.assertEqual(replica["evaluation"]["summary"]["successes"], 0)
            self.assertEqual(replica["training"]["summary"]["episodes"], 1)
        self.assertNotIn("solved", result)

    def test_invalid_seed_or_budget_requests_are_rejected_before_environment_creation(self):
        variants = []
        duplicate = request()
        duplicate["replicates"][1]["trainingEpisodeSeeds"] = [1]
        variants.append(duplicate)
        overlap = request()
        overlap["evaluation"]["randomActionSeeds"][0] = 201
        variants.append(overlap)
        insufficient = request()
        insufficient["limits"]["maxTransitions"] = 7
        variants.append(insufficient)
        for raw in variants:
            with self.subTest(raw=raw):
                def forbidden(_configuration):
                    self.fail("invalid request reached environment construction")
                with self.assertRaises(runner.InvalidRequest):
                    runner.execute(raw, make_env=forbidden, versions={})


if __name__ == "__main__":
    unittest.main()
