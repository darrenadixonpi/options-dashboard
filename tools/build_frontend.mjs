/**
 * esbuild bundle: concat ordered classic scripts (JS + TS) → single IIFE bundle.
 * TypeScript modules (.ts) are transpiled to sibling .js files for dev script tags.
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

const TS_MODULES = new Set(
  MODULE_ORDER.map((name) => name.replace(/\.js$/i, "")).filter((base) =>
    fs.existsSync(path.join(jsDir, `${base}.ts`))
  )
);

function resolveModule(name) {
  const base = name.replace(/\.js$/i, "");
  const tsPath = path.join(jsDir, `${base}.ts`);
  const jsPath = path.join(jsDir, name);
  if (fs.existsSync(tsPath)) {
    return { path: tsPath, loader: "ts", outPath: jsPath, name };
  }
  if (fs.existsSync(jsPath)) {
    return { path: jsPath, loader: "js", outPath: jsPath, name };
  }
  throw new Error(`Missing module ${name} (no .ts or .js in static/js)`);
}

async function transpileSource(mod) {
  const raw = fs.readFileSync(mod.path, "utf8");
  if (mod.loader === "js") return raw;
  const result = await esbuild.transform(raw, {
    loader: "ts",
    target: "es2020",
    tsconfigRaw: {
      compilerOptions: {
        strict: false,
        target: "ES2020",
        lib: ["ES2020", "DOM"],
      },
    },
  });
  return result.code;
}

async function emitDevScripts() {
  for (const name of MODULE_ORDER) {
    const mod = resolveModule(name);
    if (mod.loader !== "ts") continue;
    const code = await transpileSource(mod);
    fs.writeFileSync(mod.outPath, code);
  }
}

async function readOrderedSources() {
  const parts = [];
  for (const name of MODULE_ORDER) {
    parts.push(await transpileSource(resolveModule(name)));
  }
  return parts;
}

async function concatSources() {
  const parts = await readOrderedSources();
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
    tsModules: [...TS_MODULES],
    minified: !dev,
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

function renderScriptBlock() {
  // ES-module bundle only — individual classic-script tags can't carry import/export.
  return `<script src="/static/dist/app.bundle.js"></script>`;
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
  fs.mkdirSync(outDir, { recursive: true });
  const entry = path.join(jsDir, "_bundle-entry.ts");

  await esbuild.build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: "iife",
    target: ["es2020"],
    minify: !dev,
    sourcemap: dev,
    legalComments: "none",
  });

  const manifest = writeManifest();
  const kb = (manifest.bytes / 1024).toFixed(1);
  console.log(`Wrote ${path.relative(root, outFile)} (${kb} KB, hash ${manifest.hash}) — ES-module bundle of ${MODULE_ORDER.length} modules`);
  syncIndexHtml("bundle");
}

async function watchBuild() {
  console.log("Watching static/js/*.{js,ts} — rebuild on change (Ctrl+C to stop)");
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
    if (!filename) return;
    if (filename === "types.ts" || filename === "globals.d.ts") {
      console.log(`\n→ ${filename} changed`);
      run();
      return;
    }
    if (!filename.endsWith(".js") && !filename.endsWith(".ts")) return;
    const moduleName = filename.endsWith(".ts")
      ? `${filename.replace(/\.ts$/, "")}.js`
      : filename;
    if (!MODULE_ORDER.includes(moduleName)) return;
    console.log(`\n→ ${filename} changed`);
    run();
  });
}

if (args.has("--sync-index-only")) {
  syncIndexHtml("bundle");
} else if (watch) {
  await watchBuild();
} else {
  await buildOnce();
}
