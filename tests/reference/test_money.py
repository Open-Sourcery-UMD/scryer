import unittest

from scryer_reference.money import (
    MoneyError,
    checked_add,
    checked_negate,
    parse_minor_units,
    parse_us_decimal,
)


class MinorUnitTests(unittest.TestCase):
    def test_canonical_minor_units_keep_exact_integer_value(self):
        self.assertEqual(parse_minor_units("0"), 0)
        self.assertEqual(parse_minor_units("650000"), 650000)
        self.assertEqual(parse_minor_units("-30000"), -30000)
        self.assertEqual(parse_minor_units("-9223372036854775808"), -9223372036854775808)
        self.assertEqual(parse_minor_units("9223372036854775807"), 9223372036854775807)

    def test_noncanonical_minor_unit_strings_fail(self):
        for value in ("-0", "01", "+1", "1.0", "1e2", "", " 1", "1 ", "--1"):
            with self.subTest(value=value), self.assertRaises(MoneyError) as raised:
                parse_minor_units(value)
            self.assertEqual(raised.exception.code, "INVALID_MONEY")
            if value:
                self.assertNotIn(value, str(raised.exception))

    def test_minor_unit_overflow_fails(self):
        for value in ("9223372036854775808", "-9223372036854775809"):
            with self.subTest(value=value), self.assertRaises(MoneyError) as raised:
                parse_minor_units(value)
            self.assertEqual(raised.exception.code, "MONEY_OVERFLOW")


class SourceDecimalTests(unittest.TestCase):
    def test_us_decimal_source_values_are_exact(self):
        examples = {
            "6500.00": 650000,
            "(300.00)": -30000,
            "1,234.56": 123456,
            "$1,234.56": 123456,
            "0": 0,
            "1.2": 120,
            "-0.01": -1,
            "(92,233,720,368,547,758.08)": -9223372036854775808,
        }
        for value, expected in examples.items():
            with self.subTest(value=value):
                self.assertEqual(parse_us_decimal(value), expected)

    def test_unsupported_precision_is_not_rounded(self):
        with self.assertRaises(MoneyError) as raised:
            parse_us_decimal("1.234")
        self.assertEqual(raised.exception.code, "UNSUPPORTED_PRECISION")

    def test_bad_grouping_and_ambiguous_signs_fail(self):
        for value in ("12,34.56", "1,23,456", "(1.00)-", "-$1.00", "1.2.3", "1 234.56", ""):
            with self.subTest(value=value), self.assertRaises(MoneyError) as raised:
                parse_us_decimal(value)
            self.assertEqual(raised.exception.code, "INVALID_MONEY")

    def test_decimal_overflow_fails(self):
        for value in ("92,233,720,368,547,758.08", "(92,233,720,368,547,758.09)"):
            with self.subTest(value=value), self.assertRaises(MoneyError) as raised:
                parse_us_decimal(value)
            self.assertEqual(raised.exception.code, "MONEY_OVERFLOW")


class ArithmeticTests(unittest.TestCase):
    def test_checked_add_accepts_the_largest_valid_sum(self):
        self.assertEqual(checked_add(9223372036854775806, 1), 9223372036854775807)
        self.assertEqual(checked_add(-9223372036854775807, -1), -9223372036854775808)

    def test_checked_add_rejects_overflow(self):
        with self.assertRaises(MoneyError) as raised:
            checked_add(9223372036854775807, 1)
        self.assertEqual(raised.exception.code, "MONEY_OVERFLOW")

    def test_checked_negate_rejects_minimum_integer(self):
        with self.assertRaises(MoneyError) as raised:
            checked_negate(-9223372036854775808)
        self.assertEqual(raised.exception.code, "MONEY_OVERFLOW")

    def test_boolean_is_not_money(self):
        with self.assertRaises(MoneyError) as raised:
            checked_add(True, 1)
        self.assertEqual(raised.exception.code, "INVALID_MONEY")


if __name__ == "__main__":
    unittest.main()
