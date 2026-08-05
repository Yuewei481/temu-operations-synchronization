import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from build_daily_sales_totals import build_daily_total_rows


class DailySalesTotalsTest(unittest.TestCase):
    def test_sums_every_product_by_date_and_keeps_zero_dates(self):
        rows, diagnostics = build_daily_total_rows(
            {
                "rows": [
                    {
                        "skuCargoNo": "A-1",
                        "name": "Matched A",
                        "date": "2026-07-31",
                        "sales": "2",
                    },
                    {
                        "skuCargoNo": "A-1",
                        "name": "Matched A",
                        "date": "2026-08-01",
                        "sales": "0",
                    },
                    {
                        "skuCargoNo": "B-2",
                        "name": "Matched B",
                        "date": "2026-07-31",
                        "sales": "10",
                    },
                    {
                        "skuCargoNo": "B-2",
                        "name": "Matched B",
                        "date": "2026-08-01",
                        "sales": "0",
                    },
                ],
            }
        )
        self.assertEqual(
            rows,
            [
                {"date": "2026/7/31", "sales": 12},
                {"date": "2026/8/1", "sales": 0},
            ],
        )
        self.assertEqual(diagnostics, {"products": 2, "dates": 2, "values": 4})

    def test_deduplicates_the_same_matched_product_and_date(self):
        rows, diagnostics = build_daily_total_rows(
            {
                "rows": [
                    {"skuCargoNo": "A-1", "name": "A", "date": "2026-07-31", "sales": 2},
                    {"skuCargoNo": "A-1", "name": "A", "date": "2026-07-31", "sales": 2},
                ]
            }
        )
        self.assertEqual(rows, [{"date": "2026/7/31", "sales": 2}])
        self.assertEqual(diagnostics["products"], 1)

    def test_rejects_conflicting_duplicate_matched_sales(self):
        with self.assertRaisesRegex(ValueError, "Conflicting duplicate sales"):
            build_daily_total_rows(
                {
                    "rows": [
                        {"skuCargoNo": "A-1", "name": "A", "date": "2026-07-31", "sales": 2},
                        {"skuCargoNo": "A-1", "name": "A", "date": "2026-07-31", "sales": 3},
                    ],
                }
            )

    def test_rejects_an_unreadable_sales_value(self):
        with self.assertRaisesRegex(ValueError, "Missing sales value"):
            build_daily_total_rows(
                {
                    "rows": [
                        {
                            "skuCargoNo": "A-1",
                            "name": "Matched A",
                            "date": "2026-07-31",
                            "sales": None,
                        }
                    ]
                }
            )


if __name__ == "__main__":
    unittest.main()
