#!/usr/bin/env python3

import unittest

from title_history_rng import advance, randi, same_character_choice, simulate


class TitleHistoryRngTests(unittest.TestCase):
    def test_hsd_randi_advances_before_using_high_word(self):
        seed, value = randi(0x49A24038, 8)
        self.assertEqual(seed, 0xFCF6BE1B)
        self.assertEqual(value, 7)

    def test_zelda_and_sheik_are_duplicates(self):
        self.assertTrue(same_character_choice(0x12, 0x13))
        self.assertTrue(same_character_choice(0x13, 0x12))
        self.assertFalse(same_character_choice(0x12, 0x11))

    def test_latest_capture_reproduces_minimum_eight_call_path(self):
        # The latest seed draws pool indices 7,6,1,2; slots 3,1; and stage
        # index 2. Sequential pools make every choice accepted.
        result = simulate(
            0x49A24038,
            character_pool=list(range(8)),
            stage_pool=list(range(8)),
            current_stage_id=4,
        )
        self.assertEqual(result.total_calls, 8)
        self.assertEqual(result.character_rejections, 0)
        self.assertEqual(result.slot_rejections, 0)
        self.assertEqual(result.stage_rejections, 0)
        self.assertEqual(result.final_seed, 0x8D109A00)

    def test_rejections_are_included_in_total(self):
        result = simulate(
            0x19,
            character_pool=list(range(8)),
            stage_pool=list(range(8)),
            current_stage_id=4,
        )
        self.assertEqual(result.character_rejections, 3)
        self.assertEqual(result.slot_rejections, 1)
        self.assertEqual(result.stage_rejections, 1)
        self.assertEqual(result.total_calls, 13)
        self.assertEqual(result.final_seed, 0xF676B904)


if __name__ == "__main__":
    unittest.main()
