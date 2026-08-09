"""Verify the __PAGE_MODEL reference-encoding decode against a live Rightmove page.

Confirms the exact mechanic the extension's MAIN-world content script will need.
"""

import json
import re
import sys
from pathlib import Path


def extract_page_model(html: str) -> dict:
    m = re.search(r"window\.__PAGE_MODEL\s*=\s*(\{.*?\});?\s*\n", html, re.S)
    if not m:
        raise SystemExit("no window.__PAGE_MODEL found")
    # Brace-match forward from the opening brace to get the full object.
    start = m.start(1)
    depth, in_str, esc = 0, False, False
    for i in range(start, len(html)):
        c = html[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return json.loads(html[start : i + 1])
    raise SystemExit("unbalanced braces")


def decode(nodes: list, idx):
    """Resolve the index-reference encoding used when encoding == 'on'."""
    node = nodes[idx]
    if isinstance(node, dict):
        return {k: decode(nodes, v) for k, v in node.items()}
    if isinstance(node, list):
        return [decode(nodes, i) for i in node]
    return node


def main() -> None:
    html = Path(sys.argv[1]).read_text(errors="replace")
    pm = extract_page_model(html)
    print(f"top-level keys: {sorted(pm.keys())}")
    print(f"encoding: {pm.get('encoding')!r}")

    if pm.get("encoding") == "on":
        nodes = json.loads(pm["data"])
        prop = decode(nodes, nodes[0]["propertyData"])
    else:
        prop = pm["propertyData"]

    for field in ("location", "nearestStations", "nearestAirports", "address", "prices"):
        print(f"\n=== {field} ===")
        print(json.dumps(prop.get(field), indent=2)[:700])


if __name__ == "__main__":
    main()
