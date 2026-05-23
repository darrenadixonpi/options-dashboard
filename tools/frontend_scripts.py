#!/usr/bin/env python3
"""Render frontend script tags for module vs bundle mode (shared with Flask)."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_JS = ROOT / "tools" / "frontend-manifest.mjs"
INDEX_HTML = ROOT / "static" / "index.html"
DIST_MANIFEST = ROOT / "static" / "dist" / "manifest.json"

MARKER_START = "<!-- od:scripts-start -->"
MARKER_END = "<!-- od:scripts-end -->"


def _parse_module_order() -> list[str]:
    text = MANIFEST_JS.read_text(encoding="utf-8")
    match = re.search(r"MODULE_ORDER\s*=\s*\[(.*?)\]", text, re.DOTALL)
    if not match:
        raise RuntimeError(f"Could not parse MODULE_ORDER from {MANIFEST_JS}")
    return re.findall(r'"([^"]+\.js)"', match.group(1))


def render_script_block(mode: str = "modules") -> str:
    if mode == "bundle":
        return '<script src="/static/dist/app.bundle.js"></script>'
    return "\n".join(f'<script src="/static/js/{name}"></script>' for name in _parse_module_order())


def patch_index_html(mode: str = "modules") -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    if MARKER_START not in html or MARKER_END not in html:
        raise RuntimeError("index.html missing od:scripts markers")
    block = f"{MARKER_START}\n{render_script_block(mode)}\n{MARKER_END}"
    html = re.sub(
        re.escape(MARKER_START) + r".*?" + re.escape(MARKER_END),
        block,
        html,
        count=1,
        flags=re.DOTALL,
    )
    INDEX_HTML.write_text(html, encoding="utf-8")
    print(f"Patched index.html → {mode} mode")


def bundle_available() -> bool:
    bundle = ROOT / "static" / "dist" / "app.bundle.js"
    return bundle.is_file() and bundle.stat().st_size > 0


def load_dist_manifest() -> dict | None:
    if not DIST_MANIFEST.is_file():
        return None
    try:
        return json.loads(DIST_MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Toggle index.html between module and bundle script tags.")
    parser.add_argument("mode", choices=("modules", "bundle"), help="Script loading mode")
    args = parser.parse_args()
    if args.mode == "bundle" and not bundle_available():
        print("ERROR: static/dist/app.bundle.js not found — run npm run build first")
        return 1
    patch_index_html(args.mode)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
