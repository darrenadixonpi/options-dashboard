/**
 * esbuild bundle (#7): concat ordered classic scripts → single IIFE bundle.
 * Dev/default: index.html loads individual files (fast iteration, shared globals).
 * Prod: npm run build → static/dist/app.bundle.js (+ optional index sync / USE_JS_BUNDLE).
 */
import crypto from "crypto";
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MODULE_ORDER } from "./frontend-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const jsDir = path.join(root, "static", "js");
const outDir = path.join(root, "static", "dist");
const outFile = path.join(outDir, "app.bundle.js");
const manifestFile = path.join(outDir, "manifest.json");

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const dev = args.has("--dev");
const syncIndex = args.has("--sync-index") || args.has("--prod");

function readOrderedSources() {
  return MODULE_ORDER.map((file) => {
    const filePath = path.join(jsDir, file);
    if (!fs.existsSync(filePath)) throw new Error(`Missing ${file}`);
    return fs.readFileSync(filePath, "utf8");
  });
}

function concatSources() {
  const parts = readOrderedSources();
  const banner = `/* Options Dashboard bundle — built ${new Date().toISOString()} */\n`;
  return banner + parts.join("\n;\n");
}

function writeManifest() {
  const bytes = fs.readFileSync(outFile);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const manifest = {
    bundle: "app.bundle.js",
    bytes: bytes.length,
    hash,
    builtAt: new Date().toISOString(),
    modules: MODULE_ORDER,
    minified: !dev,
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

function renderScriptBlock(mode) {
  if (mode === "bundle") {
    return `<script src="/static/dist/app.bundle.js"></script>`;
  }
  return MODULE_ORDER.map((file) => `<script src="/static/js/${file}"></script>`).join("\n");
}

function syncIndexHtml(mode = "bundle") {
  const htmlPath = path.join(root, "static", "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  const start = "<!-- od:scripts-start -->";
  const end = "<!-- od:scripts-end -->";
  const startIdx = html.indexOf(start);
  const endIdx = html.indexOf(end);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    throw new Error("index.html missing od:scripts markers — run tools/rebuild_index.py or patch manually");
  }
  const block = `${start}\n${renderScriptBlock(mode)}\n${end}`;
  html = html.slice(0, startIdx) + block + html.slice(endIdx + end.length);
  fs.writeFileSync(htmlPath, html, "utf8");
  console.log(`index.html → ${mode} mode`);
}

async function buildOnce() {
  const contents = concatSources();
  fs.mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    stdin: { contents, loader: "js", sourcefile: "app-entry.js" },
    outfile: outFile,
    bundle: false,
    format: "iife",
    target: ["es2020"],
    minify: !dev,
    sourcemap: dev,
    legalComments: "none",
  });

  const manifest = writeManifest();
  const kb = (manifest.bytes / 1024).toFixed(1);
  console.log(`Wrote ${path.relative(root, outFile)} (${kb} KB, hash ${manifest.hash})`);
  if (syncIndex) syncIndexHtml("bundle");
  else {
    console.log("Dev index unchanged. For bundled index: npm run index:bundle");
    console.log("Or set USE_JS_BUNDLE=1 when starting Flask (no index edit needed).");
  }
}

async function watchBuild() {
  console.log("Watching static/js/*.js — rebuild on change (Ctrl+C to stop)");
  let building = false;
  let pending = false;

  const run = async () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      await buildOnce();
    } catch (err) {
      console.error(err.message || err);
    } finally {
      building = false;
      if (pending) {
        pending = false;
        await run();
      }
    }
  };

  await run();
  fs.watch(jsDir, { persistent: true }, (_event, filename) => {
    if (!filename || !filename.endsWith(".js") || filename === "main.js") return;
    if (!MODULE_ORDER.includes(filename)) return;
    console.log(`\n→ ${filename} changed`);
    run();
  });
}

if (args.has("--sync-index-only")) {
  syncIndexHtml(args.has("--modules") ? "modules" : "bundle");
} else if (watch) {
  await watchBuild();
} else {
  await buildOnce();
}
