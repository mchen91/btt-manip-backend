#!/usr/bin/env python3

import unittest

from map_btt_seed_to_rtc import (
    RTC_PERIOD, advance_many, calendar_second, nearby_matching_times, reverse,
    rtc_base, verify,
)


class MapBttSeedToRtcTests(unittest.TestCase):
    def test_reverse_round_trip(self):
        for seed in (0, 1, 0x12345678, 0xFFFFFFFF):
            self.assertEqual(reverse(advance_many(seed, 1)), seed)

    def test_rtc_inversion(self):
        calibration_seed = 0x10ADB866
        calibration_time = 1735689600
        timestamp = calibration_time + 1234567
        target = (calibration_seed + 40_500_000 * 1234567) & 0xFFFFFFFF
        base = rtc_base(calibration_seed, calibration_time, target)
        self.assertIsNotNone(base)
        self.assertEqual((base - timestamp) % RTC_PERIOD, 0)

    def test_seconds_filter(self):
        values = nearby_matching_times(100, 100, sampled_second=47,
                                       second_offset=7, count=3)
        self.assertTrue(values)
        self.assertTrue(all(calendar_second(value, 7) == 47 for value in values))

    def test_pre_gamecube_epoch_wraps_unsigned_rtc_seconds(self):
        # 0x34FF0528 is 1998-03-05 20:03:52 UTC. The GameCube RTC stores
        # unsigned seconds since 2000, so the subtraction underflows and adds
        # 2**32 mod 60 == 16 to the calendar seconds field.
        self.assertEqual(calendar_second(0x34FF0528, 4), 12)
        # The equivalent post-epoch boot solution has ordinary :52 + 4.
        self.assertEqual(calendar_second(0xACFF0528, 4), 56)


if __name__ == "__main__":
    unittest.main()
