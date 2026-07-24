#!/usr/bin/env python3

import json
import unittest

from analyze_peach_pull_trace import advance, find_pulls, roll_distance


def advanced(seed, count):
    for _ in range(count):
        seed = advance(seed)
    return seed


def line(tick, values):
    return f"time\\t{json.dumps({'type': 'delta', 'tick': tick, 'values': values})}"


class AnalyzePeachPullTraceTests(unittest.TestCase):
    def test_roll_distance(self):
        seed = 0x15E9AD18
        self.assertEqual(roll_distance(seed, advanced(seed, 2313)), 2313)

    def test_detects_three_pulls_and_back_corrects_transition_frame(self):
        start = 0x15E9AD18
        lines = [line(1, {
            'frame': 100,
            'match.random_seed': start,
            'stage.btargets.remaining': 10,
            'player.1.entity.action_state': 14,
            'player.1.entity.action_frame': 1,
        })]
        distances = [100, 900, 2313]
        target_counts = [9, 7, 6]
        tick = 2
        for index, (distance, targets) in enumerate(zip(distances, target_counts)):
            frame = 110 + index * 100
            # The transition is reconstructed two frames earlier. The seed
            # from that buffered boundary is the one that must be measured.
            lines.append(line(tick, {
                'frame': frame,
                'match.random_seed': advanced(start, distance),
                'stage.btargets.remaining': targets,
                'player.1.entity.action_state': 14,
                'player.1.entity.action_frame': 1,
            }))
            tick += 1
            lines.append(line(tick, {
                'frame': frame + 2,
                'player.1.entity.action_state': 352,
                'player.1.entity.action_frame': 3,
            }))
            tick += 1
            lines.append(line(tick, {
                'frame': frame + 10,
                'player.1.entity.action_state': 14,
                'player.1.entity.action_frame': 1,
            }))
            tick += 1

        pulls = find_pulls(lines, start)
        self.assertEqual([pull.number for pull in pulls], [1, 2, 3])
        self.assertEqual([pull.distance for pull in pulls], distances)
        self.assertEqual(pulls[2].detected.targets, 6)
        self.assertEqual(pulls[2].transition_frame, 310)
        self.assertEqual(pulls[2].boundary.frame, 310)
        self.assertEqual(pulls[2].previous_distance, 900)
        self.assertEqual(pulls[2].entry_rolls, 1413)

    def test_save_state_rewind_starts_a_new_attempt(self):
        start = 0x15E9AD18
        pull_seed = advanced(start, 2313)
        lines = [
            line(1, {
                'frame': 100,
                'match.random_seed': start,
                'stage.btargets.remaining': 10,
                'player.1.entity.action_state': 14,
                'player.1.entity.action_frame': 1,
            }),
            line(2, {
                'frame': 110,
                'match.random_seed': pull_seed,
                'stage.btargets.remaining': 6,
                'player.1.entity.action_state': 352,
                'player.1.entity.action_frame': 1,
            }),
            # Restore a pre-stage save state, then load the stage again.
            line(3, {
                'frame': 50,
                'match.random_seed': start,
                'stage.btargets.remaining': 0,
                'player.1.entity.action_state': 14,
            }),
            line(4, {
                'frame': 100,
                'stage.btargets.remaining': 10,
            }),
            line(5, {
                'frame': 110,
                'match.random_seed': pull_seed,
                'stage.btargets.remaining': 6,
                'player.1.entity.action_state': 352,
                'player.1.entity.action_frame': 1,
            }),
        ]
        pulls = find_pulls(lines, start)
        self.assertEqual([(pull.attempt, pull.number) for pull in pulls], [(1, 1), (2, 1)])


if __name__ == '__main__':
    unittest.main()
