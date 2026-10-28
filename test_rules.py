import unittest

from rules import evaluate_forecast


class TransitionRuleTests(unittest.TestCase):
    def test_exactly_160_outside_window_uses_main_grid(self):
        self.assertEqual(evaluate_forecast(160, 17)["grid_mode"], "Main Grid Mode")

    def test_above_160_outside_window_uses_storage(self):
        self.assertEqual(evaluate_forecast(160.01, 17)["grid_mode"], "Renewable Storage Mode")

    def test_exactly_200_triggers_overload(self):
        self.assertTrue(evaluate_forecast(200, 12)["overload_alert"])

    def test_hour_22_is_inclusive(self):
        self.assertEqual(evaluate_forecast(100, 22)["grid_mode"], "Renewable Storage Mode")

    def test_hour_23_is_outside_window(self):
        self.assertEqual(evaluate_forecast(100, 23)["grid_mode"], "Main Grid Mode")


if __name__ == "__main__":
    unittest.main()
