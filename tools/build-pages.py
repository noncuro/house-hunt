"""Render store/PRIVACY.md into the GitHub Pages site at docs/.

The Chrome Web Store requires a public privacy policy URL, and the policy has to be readable by a
person rather than delivered as raw markdown. This renders it to docs/privacy/index.html, which
GitHub Pages serves at /<repo>/privacy — a directory with an index, so the extensionless URL works
without depending on Pages' pretty-URL behaviour.

docs/.nojekyll turns Jekyll off. Nothing here needs it, and skipping it means the published page is
exactly the file in the repository rather than the output of a build nobody runs locally.

    python3 tools/build-pages.py

The markdown subset handled is the subset PRIVACY.md uses: setext-free headings, paragraphs, bullet
lists, one table, and inline bold / italic / code. It deliberately fails loudly on anything else
rather than silently emitting the source text as if it were prose.
"""

import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "store" / "PRIVACY.md"
OUT = ROOT / "docs" / "privacy" / "index.html"

STYLE = """
:root {
  --ink: #16232e;
  --muted: #5b6b7a;
  --rule: #e2e8ee;
  --accent: #1a7f5a;
  --page: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #e6edf3; --muted: #9aa9b7; --rule: #2a3742; --accent: #4cc79b; --page: #131a21; }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 48px 24px 96px; max-width: 46rem; background: var(--page); color: var(--ink);
  font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-text-size-adjust: 100%;
}
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 4px; letter-spacing: -0.015em; }
h2 {
  font-size: 1.15rem; margin: 40px 0 12px; padding-top: 20px; border-top: 1px solid var(--rule);
  letter-spacing: -0.01em;
}
p, li { color: var(--ink); }
em { color: var(--muted); font-style: normal; font-size: 0.92rem; }
strong { font-weight: 650; }
code {
  font: 0.875em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--rule);
  padding: 0.12em 0.36em; border-radius: 4px;
}
ul { padding-left: 1.25rem; }
li { margin: 6px 0; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 0.94rem; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font-weight: 650; }
td:first-child { white-space: nowrap; color: var(--accent); }
.wrap { overflow-x: auto; }
footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 0.9rem; }
a { color: var(--accent); }
"""

PAGE = """<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy policy — House hunt</title>
<meta name="description" content="What the House hunt Chrome extension collects, why, and who can see it.">
<style>{style}</style>
</head>
<body>
{body}
<footer>This page is generated from <code>store/PRIVACY.md</code> in the extension's repository.</footer>
</body>
</html>
"""


def inline(text: str) -> str:
    """Escape, then re-introduce the inline markup. Escaping first is what makes this safe."""
    out = html.escape(text)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", out)
    return out


def render(markdown: str) -> str:
    lines = markdown.split("\n")
    out: list[str] = []
    para: list[str] = []
    bullets: list[str] = []
    table: list[list[str]] = []

    def flush_para() -> None:
        nonlocal para
        if para:
            out.append(f"<p>{inline(' '.join(para))}</p>")
            para = []

    def flush_bullets() -> None:
        nonlocal bullets
        if bullets:
            items = "".join(f"<li>{inline(b)}</li>" for b in bullets)
            out.append(f"<ul>{items}</ul>")
            bullets = []

    def flush_table() -> None:
        nonlocal table
        if table:
            head, *rows = table
            th = "".join(f"<th>{inline(c)}</th>" for c in head)
            body = "".join(
                "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>" for row in rows
            )
            out.append(f'<div class="wrap"><table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>')
            table = []

    def flush_all() -> None:
        flush_para()
        flush_bullets()
        flush_table()

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()

        if not stripped:
            flush_all()
            continue

        if stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            # The |---|---| separator carries no content.
            if all(set(c) <= set("-: ") and c for c in cells):
                continue
            flush_para()
            flush_bullets()
            table.append(cells)
            continue

        if stripped.startswith("## "):
            flush_all()
            out.append(f"<h2>{inline(stripped[3:])}</h2>")
            continue

        if stripped.startswith("# "):
            flush_all()
            out.append(f"<h1>{inline(stripped[2:])}</h1>")
            continue

        if stripped.startswith("- "):
            flush_para()
            flush_table()
            bullets.append(stripped[2:])
            continue

        # A continuation of the bullet above, not a new paragraph.
        if bullets and raw.startswith("  "):
            bullets[-1] += " " + stripped
            continue

        if stripped.startswith(("#", ">", "```", "1. ")):
            sys.exit(f"build-pages: unhandled markdown -> {stripped[:60]!r}")

        flush_bullets()
        flush_table()
        para.append(stripped)

    flush_all()
    return "\n".join(out)


def main() -> None:
    body = render(SOURCE.read_text())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(PAGE.format(style=STYLE.strip(), body=body))
    (ROOT / "docs" / ".nojekyll").write_text("")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(body)} bytes of body)")


if __name__ == "__main__":
    main()
