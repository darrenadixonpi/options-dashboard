/**
 * Download pinned Chart.js + annotation plugin into static/vendor/ (Phase 1).
 * Run: node tools/vendor_charts.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const ASSETS = [
  {
    url: "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js",
    out: "static/vendor/chart.js/4.4.1/chart.umd.min.js",
  },
  {
    url: "https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js",
    out: "static/vendor/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js",
  },
];

async function main() {
  for (const { url, out } of ASSETS) {
    const dest = path.join(root, out);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`Wrote ${out} (${(buf.length / 1024).toFixed(1)} KB)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
