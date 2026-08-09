"""Sends the same floorplan to the model twice — raw, and flattened onto white — to settle
whether transparency is what made it illegible."""
import base64, json, os, sys, urllib.request
from io import BytesIO
from PIL import Image

# The repo's own .env, or ENV_FILE if it lives somewhere else. Whatever is already exported wins,
# so this works with no file at all.
ENV_FILE = os.environ.get('ENV_FILE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, '.env')
env = {}
if os.path.exists(ENV_FILE):
    for line in open(ENV_FILE, encoding='utf-8'):
        line = line.strip()
        if line.startswith('#') or '=' not in line: continue
        k, v = line.split('=', 1); env[k.strip()] = v.strip()
env.update(os.environ)
KEY = env['OPENAI_API_KEY']

url = sys.argv[1]
raw = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})).read()
im = Image.open(BytesIO(raw))
print(f"source: {im.size} mode={im.mode} {len(raw)} bytes")

flat = Image.new('RGB', im.size, (255, 255, 255))
flat.paste(im, (0, 0), im.split()[-1] if im.mode in ('LA', 'RGBA') else None)
buf = BytesIO(); flat.save(buf, format='PNG'); flattened = buf.getvalue()

PROMPT = ("Read this floorplan. Reply as JSON with keys: legible (bool), total_sqft (number or null), "
          "rooms (list of names), has_bathtub (bool or null), notes (string).")

def ask(label, data, mime):
    body = {
        "model": "gpt-5.6-terra",
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": PROMPT},
            {"type": "input_image", "image_url": f"data:{mime};base64," + base64.b64encode(data).decode(), "detail": "original"},
        ]}],
    }
    req = urllib.request.Request("https://api.openai.com/v1/responses",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    out = json.loads(urllib.request.urlopen(req, timeout=180).read())
    text = "".join(c.get("text", "") for item in out.get("output", []) for c in item.get("content", []))
    print(f"\n--- {label} ({len(data)} bytes) ---\n{text.strip()[:700]}")

ask("RAW (transparent)", raw, "image/png")
ask("FLATTENED ON WHITE", flattened, "image/png")
