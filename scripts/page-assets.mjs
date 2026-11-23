// Usage: node scripts/page-assets.mjs <index.html>
// Prints one line per file the page needs to start: the relative path (without a query or
// fragment), a tab, its integrity value ("-" when no tag gives one), a tab, and 1 when the page
// runs or starts it (a <script src>, an import in an inline script, or the .wasm path given to
// init) or 0 when the page only preloads it. Covers <link rel="modulepreload"|"preload"> and
// <script src> outside comments, and, in inline scripts the browser runs, the imports and the
// module_or_path given to init (the start-up module imports the app's script and passes its .wasm
// path to init). Exits 1 when the page names an absolute or parent-relative URL for such a file,
// gives one file two different integrity values, or has a <base> element. URLs under /cdn-cgi/,
// which Cloudflare adds to the pages it serves, are left out.
import { readFileSync } from "node:fs";

// Comments and <template> contents are never run, so they are removed first.
const raw = readFileSync(process.argv[2], "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, "");
if (/<base\b/i.test(raw.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ""))) {
  console.error("error: the page has a <base> element, which this check does not resolve");
  process.exit(1);
}
// Bodies of inline scripts the browser runs (no type, a JavaScript type or "module"), comments removed.
const inline = [];
// True for a <script> tag a current browser runs: no type, a JavaScript type or "module", and no
// nomodule attribute (browsers that run modules skip nomodule scripts).
const runs = (open) => {
  const type = (open.match(/\stype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "").toLowerCase();
  return (type === "" || type === "module" || /^(text|application)\/(java|ecma)script$/.test(type)) && !/\snomodule\b/i.test(open);
};
const html = raw.replace(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi, (_, open, body) => {
  // A script with src runs that file; browsers ignore the text between its tags.
  const external = /\ssrc\s*=/i.test(open);
  if (!external && runs(open)) {
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
function add(url, integrity, start) {
  // Cloudflare adds its own scripts to pages it serves (under /cdn-cgi/, and the Web Analytics
  // beacon); they are not site files.
  if (url.startsWith("/cdn-cgi/") || url.startsWith("https://static.cloudflareinsights.com/")) return;
  if (integrity === "-") {
    console.error(`error: ${url} has the integrity value "-", which this check uses for none`);
    process.exit(1);
  }
  const path = url.split(/[?#]/)[0].replace(/^\.\//, "");
  if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(url) || path === "" || path.split("/").includes("..")) {
    console.error(`error: the page loads ${url}, which is not a path inside the site`);
    process.exit(1);
  }
  const known = out.get(path) ?? { integrity: "", start: false };
  if (known.integrity && integrity && known.integrity !== integrity) {
    console.error(`error: the page gives ${path} two different integrity values`);
    process.exit(1);
  }
  out.set(path, { integrity: known.integrity || integrity, start: known.start || start });
}

for (const [tag] of html.matchAll(/<(link|script)\b[^>]*>/gi)) {
  const isLink = /^<link/i.test(tag);
  const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
  if (isLink && !rel.includes("preload") && !rel.includes("modulepreload")) continue;
  const url = attr(tag, isLink ? "href" : "src");
  if (url !== null) add(url, attr(tag, "integrity") ?? "", !isLink && runs(tag));
}
for (const body of inline) {
  // Static imports, dynamic imports and the .wasm path given to wasm-bindgen's init.
  const starts = [
    /\bimport\s[^"';]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bmodule_or_path\s*:\s*["']([^"']+)["']/g,
  ];
  for (const re of starts) for (const [, url] of body.matchAll(re)) add(url, "", true);
}
// An empty integrity value is written as "-": shells that split on tabs merge empty fields.
for (const [path, { integrity, start }] of out) console.log(`${path}\t${integrity || "-"}\t${start ? 1 : 0}`);
