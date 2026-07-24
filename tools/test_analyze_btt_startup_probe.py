#!/usr/bin/env python3

import unittest

from analyze_btt_startup_probe import distance, reverse
from title_history_rng import advance


class AnalyzeBttStartupProbeTests(unittest.TestCase):
    def test_reverse_is_exact_for_edge_values(self):
        for seed in (0, 1, 0x12345678, 0x7FFFFFFF, 0xFFFFFFFF):
            self.assertEqual(reverse(advance(seed)), seed)

    def test_distance_counts_forward_calls(self):
        start = 0x8D109A00
        target = start
        for _ in range(37):
            target = advance(target)
        self.assertEqual(distance(start, target), 37)


if __name__ == "__main__":
    unittest.main()
