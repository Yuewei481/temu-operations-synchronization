#!/usr/bin/env python3
import base64
import json
import mimetypes
import sys
from pathlib import Path

from PIL import Image as PillowImage

from export_sales_excel import INPUT_PATH, IMAGE_DIR, merge_rows_by_spu, read_source_excel


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = PROJECT_ROOT / "output" / "wps-append-payload.json"


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python3 scripts/build_wps_append_payload.py /path/to/source.xlsx")

    source_excel_path = Path(sys.argv[1]).expanduser().resolve()
    data = json.loads(INPUT_PATH.read_text(encoding="utf-8"))
    source_rows = read_source_excel(source_excel_path)
    rows = build_append_rows(data, source_rows)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps({"rows": rows}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved WPS append payload: {OUTPUT_PATH}")
    print(f"Rows: {len(rows)}")


def build_append_rows(data, source_rows):
    merged_rows = merge_rows_by_spu(data, source_rows)
    rows = []
    for row in merged_rows:
        if not has_collected_data(row):
            continue

        image_path = row.get("sourceImagePath")
        image_width, image_height = image_dimensions(image_path) if image_path else ("", "")
        rows.append(
            {
                "date": format_date(row.get("trafficDate") or ""),
                "name": row.get("name") or "",
                "imagePath": str(image_path) if image_path else "",
                "imageDataUrl": image_data_url(image_path) if image_path else "",
                "imageWidthPx": image_width,
                "imageHeightPx": image_height,
                "sales": number_or_blank(row.get("todaySales")),
                "exposure": number_or_blank(row.get("exposure")),
                "clicks": number_or_blank(row.get("clicks")),
                "spuId": row.get("spuId") or "",
            }
        )
    return rows


def has_collected_data(row):
    for key in ("todaySales", "trafficDate", "exposure", "clicks"):
        value = row.get(key)
        if value is not None and str(value).strip() != "":
            return True
    return False


def format_date(value):
    text = str(value).strip()
    parts = text.split("-")
    if len(parts) == 3 and all(part.isdigit() for part in parts):
        year, month, day = parts
        return f"{int(year)}/{int(month)}/{int(day)}"
    return text


def number_or_blank(value):
    if value is None:
        return ""
    text = str(value).strip().replace(",", "")
    return text


def image_data_url(path):
    image_path = Path(path)
    if not image_path.exists():
        return ""

    mime_type = mimetypes.guess_type(image_path)[0] or "image/png"
    payload = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{payload}"


def image_dimensions(path):
    image_path = Path(path)
    if not image_path.exists():
        return "", ""

    with PillowImage.open(image_path) as image:
        return image.width, image.height


if __name__ == "__main__":
    main()
