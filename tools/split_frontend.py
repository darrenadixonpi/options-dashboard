#!/usr/bin/env python3
"""Split index.html into CSS + ordered JS modules (classic scripts, window.OD namespace)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "static" / "index.html"
JS = ROOT / "static" / "js"
CSS = ROOT / "static" / "css"

# 1-based line ranges [start, end] inclusive for inline script body
RANGES = [
    ("01-parsers.js", 493, 675),
    ("02-portfolio.js", 676, 1084),
    ("03-render.js", 1085, 1377),
    ("04-state.js", 1378, 1815),
    ("05-session-api.js", 1816, 2372),
    ("06-fetch.js", 2373, 2538),
    ("07-tabs.js", 2539, 2657),
    ("08-simulate.js", 2658, 3009),
    ("09-risk.js", 3010, 3218),
    ("10-journal.js", 3219, 3307),
    ("11-roll-catalysts-init.js", 3308, 3407),
]

def main():
    lines = HTML.read_text(encoding="utf-8").splitlines()
    CSS.mkdir(parents=True, exist_ok=True)
    JS.mkdir(parents=True, exist_ok=True)

    # CSS lines 9-137 (inside style tag)
    css_lines = []
    in_style = False
    for line in lines:
        if line.strip() == "<style>":
            in_style = True
            continue
        if line.strip() == "</style>":
            break
        if in_style:
            css_lines.append(line)
    (CSS / "app.css").write_text("\n".join(css_lines) + "\n", encoding="utf-8")

    for fname, start, end in RANGES:
        chunk = "\n".join(lines[start - 1 : end])
        (JS / fname).write_text(chunk + "\n", encoding="utf-8")
        print(f"{fname}: lines {start}-{end} ({end - start + 1} lines)")

    print("Extracted CSS +", len(RANGES), "JS modules")


if __name__ == "__main__":
    main()
