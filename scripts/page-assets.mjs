// Usage: node scripts/page-assets.mjs <index.html>
// Prints one line per file the page needs to start: the relative path (without a query or
// fragment), a tab, and its integrity value (empty when no tag gives one). Covers
// <link rel="modulepreload"|"preload"> and <script src> outside comments, and, in inline scripts
// the browser runs, the imports and the module_or_path given to init (the start-up module imports
// the app's script and passes its .wasm path to init). Exits 1 when the page names an absolute or parent-relative URL for such
// a file, gives one file two different integrity values, or has a <base> element. URLs under
// /cdn-cgi/, which Cloudflare adds to the pages it serves, are left out.
import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2], "utf8").replace(/<!--[\s\S]*?-->/g, "");
if (/<base\b/i.test(raw.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ""))) {
  console.error("error: the page has a <base> element, which this check does not resolve");
  process.exit(1);
}
// Bodies of inline scripts the browser runs (no type, a JavaScript type or "module"), comments removed.
const inline = [];
const html = raw.replace(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi, (_, open, body) => {
  const type = (open.match(/\stype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "").toLowerCase();
  if (type === "" || type === "module" || /^(text|application)\/(java|ecma)script$/.test(type)) {
    inline.push(body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1"));
  }
  return open;
});

// An attribute's value, quoted with " or ' or unquoted, as HTML allows.
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};

const out = new Map();
function add(url, integrity) {
  // Cloudflare adds its own scripts under /cdn-cgi/ to pages it serves; they are not site files.
  if (url.startsWith("/cdn-cgi/")) return;
  const path = url.split(/[?#]/)[0].replace(/^\.\//, "");
  if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(url) || path === "" || path.split("/").includes("..")) {
    console.error(`error: the page loads ${url}, which is not a path inside the site`);
    process.exit(1);
  }
  const known = out.get(path);
  if (known && integrity && known !== integrity) {
    console.error(`error: the page gives ${path} two different integrity values`);
    process.exit(1);
  }
  out.set(path, known || integrity);
}

for (const [tag] of html.matchAll(/<(link|script)\b[^>]*>/gi)) {
  const isLink = /^<link/i.test(tag);
  const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
  if (isLink && !rel.includes("preload") && !rel.includes("modulepreload")) continue;
  const url = attr(tag, isLink ? "href" : "src");
  if (url !== null) add(url, attr(tag, "integrity") ?? "");
}
for (const body of inline) {
  // Static imports, dynamic imports and the .wasm path given to wasm-bindgen's init.
  const starts = [
    /\bimport\s[^"';]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bmodule_or_path\s*:\s*["']([^"']+)["']/g,
  ];
  for (const re of starts) for (const [, url] of body.matchAll(re)) add(url, "");
}
for (const [path, integrity] of out) console.log(`${path}\t${integrity}`);
