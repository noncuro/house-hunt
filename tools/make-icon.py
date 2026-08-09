"""Draw the extension icon: HH in white on a rounded green tile.

Committed as a script rather than as four opaque PNGs so the icon can be re-cut when the sizes
Chrome wants change, or when the colour does. The green is the same #1a7f5a the shortlist uses for
a good flag, so the toolbar button and the thing it opens agree with each other.

    uv run --with pillow tools/make-icon.py      # or: python3 tools/make-icon.py

Writes public/icon/{16,32,48,128}.png, which WXT copies into the bundle and the manifest names.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

GREEN = (26, 127, 90, 255)
WHITE = (255, 255, 255, 255)
SIZES = (16, 32, 48, 128)
OUT = Path(__file__).resolve().parent.parent / "public" / "icon"

# Drawn large and downsampled, because a 16px tile drawn at 16px has stair-stepped corners and
# unreadable letters. 8x is enough that LANCZOS has something to work with.
SUPERSAMPLE = 8


def font_for(px: int) -> ImageFont.FreeTypeFont:
    """The heaviest face available. A thin 'HH' disappears at 16px."""
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, px)
    raise SystemExit("no bold system font found — install one or name it above")


def draw(size: int) -> Image.Image:
    big = size * SUPERSAMPLE
    tile = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    pen = ImageDraw.Draw(tile)

    # A squircle rather than a square: Chrome draws the toolbar icon on light and dark chrome and
    # a hard-cornered tile reads as a screenshot of something rather than as an icon.
    pen.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=GREEN)

    # 0.52 of the tile is as large as "HH" goes before the two H's touch the rounded corners.
    font = font_for(int(big * 0.52))
    left, top, right, bottom = pen.textbbox((0, 0), "HH", font=font)
    # Centre on the ink, not on the line box: font metrics include ascender and descender space
    # that "HH" does not use, so centring on those sits the letters visibly low.
    pen.text(
        ((big - (right - left)) / 2 - left, (big - (bottom - top)) / 2 - top),
        "HH",
        font=font,
        fill=WHITE,
    )

    return tile.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"{size}.png"
        draw(size).save(path)
        print(f"wrote {path.relative_to(OUT.parent.parent)}")


if __name__ == "__main__":
    main()
