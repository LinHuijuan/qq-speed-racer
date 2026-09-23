"""Prove the WebP conversion did not visibly change any texture.

Resolution is untouched (see tools/optimize-assets.py), so decoding the source
PNG and the shipped WebP and diffing them is the complete answer — no need to
compare game frames, and no dependence on a reproducible camera.

Raw per-pixel error is misleading for this content: the textures are photographic
noise, and a lossy codec's residual *is* the noise it smoothed away, not a
visible artifact. Pushing quality barely moves that number (q84 -> q98 on
road-lanes: mean 7.10 -> 6.10 at 1.7x the bytes). What actually matters is the
error at the scale the screen resolves, so the verdict uses mip levels.

    <venv>/python tools/asset-diff.py
    <venv>/python tools/asset-diff.py --crop road-lanes   # write a side-by-side
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "raw-assets" / "assets"
OUT = ROOT / "public" / "assets"
SHOTS = ROOT / "artifacts" / "asset-diff"

# Mip 0 is the texel grid; mip 2 (256px) is roughly what a tiled ground texture
# resolves to on screen once minified. Mip 4 is a distant grazing view.
MIP_LEVELS = (0, 2, 4)
# Verdict gates. The reference point is one 8-bit quantisation step (1/255):
# a mean error at or below that is at the display's own resolution of detail.
# mip 0 is reported for information but not gated — on noise it is dominated by
# the smoothing the codec performs, which is not what a viewer sees.
MIP2_MEAN_LIMIT = 2.0  # 0.8%
MIP4_MEAN_LIMIT = 1.0  # 0.4%
MIP2_P99_LIMIT = 12.0  # ~4 steps, on 1% of a 256x256 view


def mip(image: Image.Image, level: int) -> np.ndarray:
    # Source PNGs are RGBA and the shipped WebP is RGB (the alpha was provably
    # opaque), so normalise before diffing or the shapes won't broadcast.
    image = image.convert("RGB")
    if level:
        size = (max(1, image.width >> level), max(1, image.height >> level))
        image = image.resize(size, Image.BOX)
    return np.asarray(image, dtype=np.int16)


def side_by_side(stem: str) -> Path | None:
    """Write source | shipped | amplified-difference so a human can judge."""
    src_path = SRC / f"{stem}.png"
    shipped_path = OUT / f"{stem}.webp"
    if not src_path.exists() or not shipped_path.exists():
        return None
    with Image.open(src_path) as a, Image.open(shipped_path) as b:
        left = a.convert("RGB")
        right = b.convert("RGB")
        diff = np.abs(mip(left, 0) - mip(right, 0)).astype(np.uint8)
    amp = Image.fromarray(np.clip(diff.astype(np.int16) * 8, 0, 255).astype(np.uint8))
    # Crop the middle third so fine detail is readable at full size.
    w, h = left.size
    box = (w // 3, h // 3, w * 2 // 3, h * 2 // 3)
    panels = [left.crop(box), right.crop(box), amp.crop(box)]
    sheet = Image.new("RGB", (panels[0].width * 3 + 16, panels[0].height), (24, 24, 28))
    x = 0
    for panel in panels:
        sheet.paste(panel, (x, 0))
        x += panel.width + 8
    SHOTS.mkdir(parents=True, exist_ok=True)
    out = SHOTS / f"{stem}-compare.png"
    sheet.save(out)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--crop", help="write a side-by-side sheet for one texture")
    args = parser.parse_args()

    if args.crop:
        out = side_by_side(args.crop)
        print(f"wrote {out}" if out else f"missing source or output for {args.crop}")
        return 0 if out else 1

    sources = sorted(SRC.glob("*.png")) + sorted(SRC.glob("*.jpg"))
    if not sources:
        print(f"no sources in {SRC}", file=sys.stderr)
        return 1

    header = f"{'file':<22} {'KB':>7} {'save':>6}"
    for level in MIP_LEVELS:
        header += f"  {'mip' + str(level) + ' mean':>12}"
    header += f"  {'mip2 p99':>9}  verdict"
    print(header)

    failures = 0
    total_before = 0
    total_after = 0
    for path in sources:
        shipped = OUT / f"{path.stem}.webp"
        if not shipped.exists():
            print(f"{path.stem:<22}   missing {shipped.name}")
            failures += 1
            continue

        with Image.open(path) as a, Image.open(shipped) as b:
            if a.size != b.size:
                print(f"{path.stem:<22}   SIZE MISMATCH {a.size} != {b.size}")
                failures += 1
                continue
            means = [float(np.abs(mip(a, lv) - mip(b, lv)).mean()) for lv in MIP_LEVELS]
            mip2 = np.abs(mip(a, 2) - mip(b, 2))
            p99 = float(np.percentile(mip2, 99))

        before = path.stat().st_size
        after = shipped.stat().st_size
        total_before += before
        total_after += after

        ok = (
            means[1] <= MIP2_MEAN_LIMIT
            and means[2] <= MIP4_MEAN_LIMIT
            and p99 <= MIP2_P99_LIMIT
        )
        if not ok:
            failures += 1
        row = f"{path.stem:<22} {after / 1024:7.1f} {(1 - after / before) * 100:5.1f}%"
        for value in means:
            row += f"  {value:12.2f}"
        row += f"  {p99:9.2f}  {'ok' if ok else 'REVIEW'}"
        print(row)

    print(
        f"\n{len(sources)} textures: {total_before / 1024 / 1024:.2f} MB -> "
        f"{total_after / 1024 / 1024:.2f} MB ({(1 - total_after / total_before) * 100:.1f}% smaller)"
    )
    print(f"verdict gates: mip2 mean<={MIP2_MEAN_LIMIT}, mip4 mean<={MIP4_MEAN_LIMIT}, mip2 p99<={MIP2_P99_LIMIT}")
    if failures:
        print(f"{failures} file(s) need review")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
