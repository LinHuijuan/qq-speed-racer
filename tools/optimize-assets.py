"""Rebuild public/assets from raw-assets.

The shipped textures are photographic noise stored as PNG, which is close to the
worst case for that codec: 18 files cost 42.9 MB. They are also RGBA with a fully
opaque alpha channel, so a quarter of those bytes are provably dead.

Source of truth is raw-assets/ (outside public/, so Vite neither serves nor copies
it). Re-run this after replacing any source image:

    <venv>/python tools/optimize-assets.py            # write public/assets/*.webp
    <venv>/python tools/optimize-assets.py --dry-run  # report sizes, write nothing

Images nothing references live in raw-assets/unused/ and are deliberately not
emitted — the glob below is non-recursive, so archiving a file there is what
takes it out of the build.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "raw-assets" / "assets"
OUT = ROOT / "public" / "assets"

# quality: WebP quality. max_width: downscale if wider (None keeps the source size).
# Sizes stay at the source resolution on purpose — the format change alone gets
# 90.9%, and keeping the texels means the change cannot alter the image at all.
PLAN: dict[str, dict[str, object]] = {
    "sky-city": {"quality": 84, "max_width": 2048},
    "road-lanes": {"quality": 84, "max_width": 1024},
    "runoff": {"quality": 80, "max_width": 1024},
    "ground-night": {"quality": 80, "max_width": 1024},
    "start-checker": {"quality": 84, "max_width": 1024},
    "concrete-wall": {"quality": 82, "max_width": 1024},
    "grandstand": {"quality": 82, "max_width": 1024},
    "metal-rail": {"quality": 82, "max_width": 1024},
    "building-facade": {"quality": 82, "max_width": 1024},
    "billboard-neon": {"quality": 86, "max_width": 1024},
    "item-box": {"quality": 86, "max_width": 1024},
    "pit-garage": {"quality": 82, "max_width": 1024},
    "boost-pad": {"quality": 86, "max_width": 1024},
    "kart-livery": {"quality": 86, "max_width": 1024},
    "kart-livery-red": {"quality": 86, "max_width": 1024},
    "kart-livery-gold": {"quality": 86, "max_width": 1024},
    "kart-livery-purple": {"quality": 86, "max_width": 1024},
}

DEFAULT = {"quality": 84, "max_width": 1024}


def encode(image: Image.Image, quality: int) -> bytes:
    import io

    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=quality, method=6)
    return buffer.getvalue()


def prepare(path: Path, max_width: int) -> tuple[Image.Image, str]:
    """Flatten to RGB when the alpha channel carries no information."""
    with Image.open(path) as im:
        im.load()
        note = ""
        if im.mode in ("RGBA", "LA", "PA"):
            lo, hi = im.getchannel("A").getextrema()
            if lo == hi:
                im = im.convert("RGB")
                note = "alpha-dropped"
            else:
                note = "alpha-kept"
        elif im.mode != "RGB":
            im = im.convert("RGB")
            note = f"converted-from-{im.mode}"

        if max_width and im.width > max_width:
            height = round(im.height * max_width / im.width)
            im = im.resize((max_width, height), Image.LANCZOS)
            note = f"{note} resized->{max_width}x{height}".strip()
        return im, note


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quality", type=int, help="override quality for every file")
    args = parser.parse_args()

    if not SRC.is_dir():
        print(f"missing source directory: {SRC}", file=sys.stderr)
        return 1

    if not args.dry_run:
        OUT.mkdir(parents=True, exist_ok=True)

    sources = sorted(SRC.glob("*.png")) + sorted(SRC.glob("*.jpg"))
    if not sources:
        print(f"no source images in {SRC}", file=sys.stderr)
        return 1

    total_before = 0
    total_after = 0
    print(f"{'file':<24} {'source':>11} {'->':>11} {'before':>10} {'after':>9} {'save':>7}  note")
    for path in sources:
        stem = path.stem
        spec = PLAN.get(stem, DEFAULT)
        quality = args.quality or int(spec["quality"])  # type: ignore[arg-type]
        max_width = int(spec["max_width"])  # type: ignore[arg-type]

        image, note = prepare(path, max_width)
        data = encode(image, quality)
        before = path.stat().st_size
        after = len(data)
        total_before += before
        total_after += after

        with Image.open(path) as probe:
            src_dims = f"{probe.size[0]}x{probe.size[1]}"
        dst_dims = f"{image.width}x{image.height}"

        if not args.dry_run:
            (OUT / f"{stem}.webp").write_bytes(data)

        print(
            f"{stem:<24} {src_dims:>11} {dst_dims:>11} "
            f"{before / 1024:9.1f}K {after / 1024:8.1f}K "
            f"{(1 - after / before) * 100:6.1f}%  q{quality} {note}"
        )

    print(
        f"\n{len(sources)} files: {total_before / 1024 / 1024:.2f} MB -> "
        f"{total_after / 1024 / 1024:.2f} MB "
        f"({(1 - total_after / total_before) * 100:.1f}% smaller)"
    )
    if args.dry_run:
        print("(dry run - nothing written)")
    else:
        print(f"written to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
