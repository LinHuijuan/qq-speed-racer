"""Report size / dimensions / alpha usage of every texture in public/.

Run:  <venv>/python tools/asset-report.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

total = 0
rows = []
for path in sorted(PUBLIC.rglob("*")):
    if not path.is_file():
        continue
    size = path.stat().st_size
    total += size
    entry = {"rel": str(path.relative_to(ROOT)).replace("\\", "/"), "bytes": size}
    try:
        with Image.open(path) as im:
            entry["size"] = f"{im.size[0]}x{im.size[1]}"
            entry["mode"] = im.mode
            if im.mode in ("RGBA", "LA", "PA"):
                lo, hi = im.getchannel("A").getextrema()
                entry["alpha"] = f"{lo}..{hi}"
                entry["alpha_flat"] = lo == hi
            else:
                entry["alpha"] = "-"
                entry["alpha_flat"] = None
    except Exception as exc:  # noqa: BLE001 - report, don't crash
        entry["size"] = f"<unreadable: {exc}>"
        entry["mode"] = "?"
        entry["alpha"] = "?"
        entry["alpha_flat"] = None
    rows.append(entry)

width = max(len(r["rel"]) for r in rows)
print(f"{'file'.ljust(width)}  {'dims':>11}  {'mode':>5}  {'alpha':>11}  {'flat?':>6}  {'KB':>9}")
for r in rows:
    flat = "-" if r["alpha_flat"] is None else ("FLAT" if r["alpha_flat"] else "used")
    print(
        f"{r['rel'].ljust(width)}  {r['size']:>11}  {r['mode']:>5}  "
        f"{r['alpha']:>11}  {flat:>6}  {r['bytes'] / 1024:9.1f}"
    )

print(f"\n{len(rows)} files, {total / 1024 / 1024:.2f} MB total")
flat = [r for r in rows if r["alpha_flat"]]
if flat:
    saved = sum(r["bytes"] for r in flat)
    print(f"flat-alpha files: {len(flat)} ({saved / 1024 / 1024:.2f} MB)")
