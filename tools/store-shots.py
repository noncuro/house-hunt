"""Cut the smoke harness's screenshots into the 1280x800 tiles the Chrome Web Store wants.

The harness screenshots are element captures at whatever size the element happened to be, and the
store rejects anything that is not exactly 1280x800 or 640x400. So each one is cropped to the part
worth looking at, scaled to fit, and centred on a canvas in the app's own background colour.

Sources are deliberately the FIXTURE runs, not runs against the real database: the fixture user is
"Smoke Fixture" with an @example.test address and six invented flats, so nothing personal reaches a
public listing. The cost of that choice is visible here — `keepOffline` answers Rightmove's image
CDN with a placeholder tile, so any view showing photographs looks broken and is excluded below.

    python3 tools/store-shots.py        # writes ~/Downloads/house-hunt-store-shots/
"""

from pathlib import Path

from PIL import Image, ImageDraw

W, H = 1280, 800
BACKGROUND = (244, 246, 248)
MARGIN = 32

SHOTS = Path(__file__).resolve().parent.parent / ".fixtures" / "shots"
OUT = Path.home() / "Downloads" / "house-hunt-store-shots"

# The fixture account's identity line — "Smoke Fixture · smoke-fixture@example.test · Sign out" —
# sits just under the page title on every shortlist view. It is not personal data (the address is
# invented) but it reads as somebody's leftover test run on a public store page, so it is painted
# out in the page's own background colour. Nothing about the product's behaviour is altered; only
# the demo account's name is removed.
# Wide enough for every view: the line starts at x=20 on the table views and x=108 on the map.
IDENTITY_LINE = (14, 74, 720, 100)

# (source, crop box or None, redaction boxes, output name). Crops keep the part that says something
# and drop the dead space below it — a table with two rows and 700px of white underneath reads as
# an empty app.
PLATES = [
    ("88023648.png", None, (), "1-panel-on-a-listing.png"),
    ("shortlist-compare.png", (0, 8, 1180, 320), (IDENTITY_LINE,), "2-compare-every-place.png"),
    ("shortlist-map.png", (0, 8, 1180, 685), (IDENTITY_LINE,), "3-map.png"),
    ("shortlist-triage.png", (0, 8, 1180, 400), (IDENTITY_LINE,), "4-triage-the-pile.png"),
    ("shortlist-sweep.png", (0, 8, 1180, 545), (IDENTITY_LINE,), "5-work-through-a-search.png"),
]


def plate(source: Path, crop, redactions, out: Path) -> None:
    im = Image.open(source).convert("RGB")

    # Painted before the crop, so the boxes are in the source's own coordinates and stay correct
    # when a crop is retuned.
    if redactions:
        pen = ImageDraw.Draw(im)
        for box in redactions:
            pen.rectangle(box, fill=im.getpixel((4, 4)))

    if crop:
        # Never crop past the real image: a short screenshot would otherwise be padded with black.
        im = im.crop((crop[0], crop[1], min(crop[2], im.width), min(crop[3], im.height)))

    # Fit rather than fill. Filling would crop a table mid-column, and a store screenshot exists to
    # be read.
    scale = min((W - 2 * MARGIN) / im.width, (H - 2 * MARGIN) / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)

    canvas = Image.new("RGB", (W, H), BACKGROUND)
    canvas.paste(im, ((W - im.width) // 2, (H - im.height) // 2))
    canvas.save(out)
    print(f"{out.name:34} from {source.name} at {im.width}x{im.height}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, crop, redactions, out in PLATES:
        source = SHOTS / name
        if not source.exists():
            print(f"SKIP {name} — not in .fixtures/shots, run the smoke harnesses first")
            continue
        plate(source, crop, redactions, OUT / out)
    print(f"\n{OUT}")


if __name__ == "__main__":
    main()
