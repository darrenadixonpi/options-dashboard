#!/usr/bin/env python3
"""Rebuild index.html to use external CSS/JS modules."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "static" / "index.html"

JS_FILES = [
    "01-parsers.js",
    "02-portfolio.js",
    "03-render.js",
    "04-state.js",
    "05-session-api.js",
    "06-fetch.js",
    "07-tabs.js",
    "08-simulate.js",
    "09-risk.js",
    "10-journal.js",
    "11-roll-catalysts-init.js",
    "12-snapshots.js",
]

SNAPSHOT_HTML = """
      <div class="outer" style="padding:20px;margin-top:20px" id="snapshot-history-section" hidden>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div style="font-weight:500;font-size:14px">Desk snapshot history</div>
          <button class="btn btn-sm btn-ghost" type="button" id="btn-refresh-snapshots">Refresh</button>
        </div>
        <div style="font-size:10px;color:var(--tx3);margin-bottom:14px;line-height:1.45">Stored in <code style="font-family:var(--mono)">portfolio.db</code> on each fetch — attribution totals after re-fetch, book greeks per fetch, and fetch log.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div>
            <div style="font-size:11px;font-weight:500;margin-bottom:6px">Attribution total (re-fetch)</div>
            <div id="snapshot-attribution-chart-wrap"></div>
          </div>
          <div>
            <div style="font-size:11px;font-weight:500;margin-bottom:6px">Book greeks over time</div>
            <div id="snapshot-greek-chart-wrap"></div>
          </div>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:11px;font-weight:500;margin-bottom:6px">Per-ticker price + IV</div>
          <select id="snapshot-ticker-select" style="margin-bottom:8px;padding:6px 8px;border-radius:var(--radius);border:1px solid var(--bd);background:var(--bg2);color:var(--tx);font-family:var(--mono);font-size:11px"></select>
          <div id="snapshot-ticker-chart-wrap"></div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:500;margin-bottom:6px">Recent fetches</div>
          <div id="snapshot-sessions-list"></div>
        </div>
      </div>
"""


def main():
    text = HTML.read_text(encoding="utf-8")

    # Replace style block with link
    text = re.sub(
        r"<style>.*?</style>",
        '<link rel="stylesheet" href="/static/css/app.css">',
        text,
        count=1,
        flags=re.DOTALL,
    )

    # Insert snapshot section before closing history-content (before chart container end or after table)
    if "snapshot-history-section" not in text:
        text = text.replace(
            '<div class="outer" style="padding:20px;margin-top:20px" id="history-chart-container" hidden>',
            SNAPSHOT_HTML + '\n      <div class="outer" style="padding:20px;margin-top:20px" id="history-chart-container" hidden>',
        )

    # Replace inline app script (largest script block after chart CDN)
    scripts = list(re.finditer(r"<script(?:\s[^>]*)?>(.*?)</script>", text, re.DOTALL))
    inline_idx = None
    for i, m in enumerate(scripts):
        if len(m.group(1)) > 50000:
            inline_idx = i
            break
    if inline_idx is None:
        raise SystemExit("Could not find inline app script")

    script_tags = '\n'.join(
        f'<script src="/static/js/{fn}"></script>' for fn in JS_FILES
    )
    script_tags = (
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>\n'
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"></script>\n'
        '<!-- od:scripts-start -->\n'
        + script_tags
        + '\n<!-- od:scripts-end -->'
    )

    # Remove all script blocks and re-add CDN + modules before </body>
    text = re.sub(r"<script(?:\s[^>]*)?>.*?</script>\s*", "", text, flags=re.DOTALL)
    text = text.replace("</body>", script_tags + "\n</body>")

    HTML.write_text(text, encoding="utf-8")
    print("Rebuilt index.html with", len(JS_FILES), "JS modules")


if __name__ == "__main__":
    main()
