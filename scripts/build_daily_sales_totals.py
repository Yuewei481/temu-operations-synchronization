#!/usr/bin/env python3
import json
import os
import re
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
INPUT_PATH = Path(
    os.environ.get("WPS_UPDATE_PAYLOAD")
    or os.environ.get("WPS_APPEND_PAYLOAD")
    or PROJECT_ROOT / "output" / "wps-append-payload.json"
).expanduser().resolve()
OUTPUT_PATH = Path(
    os.environ.get("WPS_DAILY_TOTAL_PAYLOAD")
    or PROJECT_ROOT / "output" / "wps-daily-sales-totals.json"
).expanduser().resolve()


def main():
    data = json.loads(INPUT_PATH.read_text(encoding="utf-8"))
    rows, diagnostics = build_daily_total_rows(data)
    if not rows:
        raise ValueError(f"No dated sales values found in {INPUT_PATH}")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"rows": rows, "diagnostics": diagnostics}
    OUTPUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Saved WPS daily sales totals: {OUTPUT_PATH}")
    print(f"Dates: {len(rows)}")
    print(f"Products: {diagnostics['products']}")


def build_daily_total_rows(data):
    matched_rows = list(data.get("rows") or [])
    if not matched_rows:
        return [], {"products": 0, "dates": 0, "values": 0}

    values_by_product_date = {}
    product_ids = set()

    for index, row in enumerate(matched_rows, start=1):
        product_id = product_identifier(row, index)
        product_ids.add(product_id)
        sales_date = normalize_date(row.get("date"))
        if not sales_date:
            raise ValueError(f"Invalid or missing sales date for matched product {product_id}")
        sales = decimal_sales(row.get("sales"), product_id, sales_date)
        key = (product_id, sales_date)
        previous = values_by_product_date.get(key)
        if previous is not None and previous != sales:
            raise ValueError(
                f"Conflicting duplicate sales for matched product {product_id} on {sales_date}: "
                f"{previous} vs {sales}"
            )
        values_by_product_date[key] = sales

    totals = defaultdict(Decimal)
    for (_, sales_date), sales in values_by_product_date.items():
        totals[sales_date] += sales

    rows = [
        {"date": display_date(sales_date), "sales": json_number(totals[sales_date])}
        for sales_date in sorted(totals)
    ]
    return rows, {
        "products": len(product_ids),
        "dates": len(rows),
        "values": len(values_by_product_date),
    }


def product_identifier(row, index):
    for key in ("skuCargoNo", "skcCargoNo", "skuId", "id"):
        value = str(row.get(key) or "").strip()
        if value:
            return value
    name = str(row.get("name") or "").strip()
    if name:
        return name
    return f"record-{index}"


def normalize_date(value):
    text = str(value or "").strip().replace("/", "-").replace(".", "-")
    match = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", text)
    if not match:
        return ""
    year, month, day = (int(part) for part in match.groups())
    try:
        date(year, month, day)
    except ValueError:
        return ""
    return f"{year:04d}-{month:02d}-{day:02d}"


def display_date(value):
    year, month, day = (int(part) for part in value.split("-"))
    return f"{year}/{month}/{day}"


def decimal_sales(value, product_id, sales_date):
    text = str(value if value is not None else "").strip().replace(",", "")
    if not text:
        raise ValueError(f"Missing sales value for product {product_id} on {sales_date}")
    try:
        number = Decimal(text)
    except InvalidOperation as error:
        raise ValueError(
            f"Invalid sales value for product {product_id} on {sales_date}: {value}"
        ) from error
    if not number.is_finite():
        raise ValueError(f"Non-finite sales value for product {product_id} on {sales_date}: {value}")
    return number


def json_number(value):
    return int(value) if value == value.to_integral_value() else float(value)


if __name__ == "__main__":
    main()
