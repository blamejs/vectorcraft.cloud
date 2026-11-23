import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { acceptsBrotli, bodyInit, filePath, parseState, precondition, resetPointers } from "../src/index.js";

// A small stand-in for an R2 bucket binding: get and head over a mutable map of key -> text.
function bucket(files) {
  const meta = (key) => ({ key, size: Buffer.byteLength(files[key]), httpEtag: `"${key}"`, uploaded: new Date(0) });
  return {
    files,
    async get(key) {
      if (!(key in files)) return null;
      const text = files[key];
      return { ...meta(key), body: text, text: async () => text };
    },
    async head(key) {
      return key in files ? meta(key) : null;
    },
  };
}

const FILES = () => ({
  STATE: "current=v2\nprevious=v1\nchecked=v2\n",
  "builds/v2/index.html": "<html>v2</html>",
  "builds/v2/app-0123456789abcdef.js": "js2",
  "builds/v2/app-0123456789abcdef_bg.wasm": "wasm2",
  "builds/v2/app-0123456789abcdef_bg.wasm.br": "br2",
  "builds/v2/fonts/a.ttf": "font",
  "builds/v1/index.html": "<html>v1</html>",
  "builds/v1/app-fedcba9876543210.js": "js1",
});

let env;
const get = (path, headers = {}, method = "GET", cf = undefined) => {
  const request = new Request(`https://example.test${path}`, { method, headers });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return worker.fetch(request, env);
};

beforeEach(() => {
  resetPointers();
  env = { SITE: bucket(FILES()) };
});

test("the root serves the current build's index.html without caching", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "<html>v2</html>");
  assert.equal(r.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(r.headers.get("Cache-Control"), "no-cache");
  assert.equal(r.headers.get("X-Build"), "v2");
});

test("hashed files are immutable and others are cached for an hour", async () => {
  const js = await get("/app-0123456789abcdef.js");
  assert.equal(js.headers.get("Content-Type"), "text/javascript; charset=utf-8");
  assert.equal(js.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  const font = await get("/fonts/a.ttf");
  assert.equal(font.headers.get("Content-Type"), "font/ttf");
  assert.equal(font.headers.get("Cache-Control"), "public, max-age=3600");
  env.SITE.files["builds/v2/snippets/x/inline0.js"] = "s";
  assert.equal((await get("/snippets/x/inline0.js")).headers.get("Cache-Control"), "no-cache");
});

test("wasm goes Brotli-compressed only to clients that accept br", async () => {
  const br = await get("/app-0123456789abcdef_bg.wasm", { "Accept-Encoding": "gzip, br" });
  assert.equal(br.headers.get("Content-Encoding"), "br");
  assert.equal(br.headers.get("Content-Type"), "application/wasm");
  assert.equal(br.headers.get("Vary"), "Accept-Encoding");
  assert.equal(await br.text(), "br2");
  const plain = await get("/app-0123456789abcdef_bg.wasm", { "Accept-Encoding": "gzip, br;q=0" });
  assert.equal(plain.headers.get("Content-Encoding"), null);
  assert.equal(await plain.text(), "wasm2");
});

test("the client's own Accept-Encoding wins over a rewritten header", async () => {
  const r = await get("/app-0123456789abcdef_bg.wasm", { "Accept-Encoding": "br, gzip" }, "GET", { clientAcceptEncoding: "identity" });
  assert.equal(r.headers.get("Content-Encoding"), null);
  assert.equal(await r.text(), "wasm2");
});

test("a file missing from the current build comes from the previous one, index.html never does", async () => {
  const r = await get("/app-fedcba9876543210.js");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Build"), "v1");
  assert.equal(r.headers.get("X-Current-Build"), "v2");
  const miss = await get("/missing.html");
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get("X-Current-Build"), "v2");
});

test("a file found in neither cached build makes the Worker read the pointers again", async () => {
  assert.equal((await get("/")).headers.get("X-Build"), "v2");
  env.SITE.files["builds/v3/index.html"] = "<html>v3</html>";
  env.SITE.files["builds/v3/app-1111111111111111.js"] = "js3";
  env.SITE.files.STATE = "current=v3\nprevious=v2\nchecked=\n";
  const r = await get("/app-1111111111111111.js");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Build"), "v3");
});

test("If-None-Match gives 304 for GET and HEAD, If-Match a mismatch gives 412", async () => {
  const etag = '"builds/v2/fonts/a.ttf"';
  assert.equal((await get("/fonts/a.ttf", { "If-None-Match": etag })).status, 304);
  assert.equal((await get("/fonts/a.ttf", { "If-None-Match": `W/${etag}` }, "HEAD")).status, 304);
  assert.equal((await get("/fonts/a.ttf", { "If-Match": '"other"' })).status, 412);
  assert.equal((await get("/fonts/a.ttf", { "If-Match": etag })).status, 200);
  const h = await get("/fonts/a.ttf", {}, "HEAD");
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("Content-Length"), "4");
  assert.equal(await h.text(), "");
});

test("other methods, dot and underscore files, MANIFEST and bad paths are refused", async () => {
  env.SITE.files["builds/v2/.htaccess"] = "x";
  env.SITE.files["builds/v2/_headers"] = "x";
  env.SITE.files["builds/v2/MANIFEST"] = "builds/v2/index.html\n";
  env.SITE.files["builds/v2/a/.b"] = "x";
  assert.equal((await get("/", {}, "POST")).status, 405);
  for (const p of ["/.htaccess", "/_headers", "/MANIFEST", "/a/.b", "/a//b", "/%E0%A4%A"]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test("filePath refuses raw traversal and dot segments", () => {
  for (const p of ["/a/../b", "/../STATE", "/./index.html", "/a/./b", "/%2e%2e/STATE", "/a/%2E/b"]) {
    assert.equal(filePath(p), null, p);
  }
});

test("a path whose key would pass R2's 1,024-byte limit is a 404 without an R2 call", async () => {
  const calls = [];
  const inner = env.SITE;
  env = { SITE: { get: (k) => (calls.push(k), inner.get(k)), head: (k) => (calls.push(k), inner.head(k)) } };
  const r = await get(`/${"a".repeat(1100)}.js`);
  assert.equal(r.status, 404);
  assert.deepEqual(calls.filter((k) => k.startsWith("builds/")), []);
});

test("every response varies by Accept-Encoding", async () => {
  for (const p of ["/", "/app-0123456789abcdef.js", "/fonts/a.ttf", "/app-0123456789abcdef_bg.wasm"]) {
    assert.equal((await get(p)).headers.get("Vary"), "Accept-Encoding", p);
  }
});

test("If-Modified-Since gives 304 only for hashed files and only without If-None-Match", async () => {
  const later = new Date(1000).toUTCString();
  const js = "/app-0123456789abcdef.js";
  assert.equal((await get(js, { "If-Modified-Since": later })).status, 304);
  assert.equal((await get(js, { "If-Modified-Since": later, "If-None-Match": '"other"' })).status, 200);
  assert.equal((await get(js, { "If-Modified-Since": "not a date" })).status, 200);
  assert.equal((await get("/", { "If-Modified-Since": later })).status, 200);
  assert.equal((await get("/fonts/a.ttf", { "If-Modified-Since": later })).status, 200);
});

test("after a rollback a browser holding the newer index.html by date gets the served one", async () => {
  const held = new Date(5000).toUTCString();
  env.SITE.files.STATE = "current=v1\nprevious=v2\nchecked=v1\n";
  const r = await get("/", { "If-Modified-Since": held });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "<html>v1</html>");
});

test("a Brotli body is sent as stored and a plain one may be compressed", () => {
  const h = new Headers();
  assert.equal(bodyInit(h, "br").encodeBody, "manual");
  assert.equal(bodyInit(h, null).encodeBody, "automatic");
});

test("after a rollback the failed build's hashed files still come from it", async () => {
  env.SITE.files.STATE = "current=v1\nprevious=v2\nchecked=v1\n";
  assert.equal((await get("/")).headers.get("X-Build"), "v1");
  const r = await get("/app-0123456789abcdef.js");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Build"), "v2");
});

test("an R2 failure gives 503 without cached ids and the cached build with them", async () => {
  const inner = env.SITE;
  let failing = false;
  const guard = (f) => (k) => (failing ? Promise.reject(new Error("R2 down")) : f(k));
  env = { SITE: { get: guard((k) => inner.get(k)), head: guard((k) => inner.head(k)) } };
  failing = true;
  assert.equal((await get("/")).status, 503);
  failing = false;
  assert.equal((await get("/")).status, 200);
  env = { SITE: { get: (k) => (k === "STATE" ? Promise.reject(new Error("R2 down")) : inner.get(k)), head: (k) => inner.head(k) } };
  // A miss forces a STATE read; when that fails the Worker cannot tell the file is absent.
  assert.equal((await get("/missing-file.js")).status, 503);
  assert.equal((await get("/")).headers.get("X-Build"), "v2");
  env = { SITE: { get: () => Promise.reject(new Error("R2 down")), head: () => Promise.reject(new Error("R2 down")) } };
  assert.equal((await get("/")).status, 503);
});

test("no published build, an empty current or a damaged STATE answers 503", async () => {
  for (const files of [{}, { STATE: "current=\nprevious=v1\n" }, { STATE: "current=v 2\n" }, { STATE: "garbage" }]) {
    resetPointers();
    env = { SITE: bucket(files) };
    assert.equal((await get("/")).status, 503, JSON.stringify(files));
  }
});

test("parseState", () => {
  assert.deepEqual(parseState("current=a\nprevious=b\nchecked=a\n"), { current: "a", previous: "b" });
  assert.deepEqual(parseState(" current = a \r\nprevious=a\n"), { current: "a", previous: null });
  assert.deepEqual(parseState("current=a\nprevious=../x\n"), { current: null, previous: null });
});

test("filePath, acceptsBrotli and precondition", () => {
  assert.equal(filePath("/"), "index.html");
  assert.equal(filePath("/fonts/"), "fonts/index.html");
  assert.equal(filePath("/a%20b.js"), "a b.js");
  assert.equal(filePath("/a\\b"), null);
  assert.equal(acceptsBrotli("br"), true);
  assert.equal(acceptsBrotli("gzip, br;q=0.5"), true);
  assert.equal(acceptsBrotli("br;q=0, gzip"), false);
  assert.equal(acceptsBrotli("brotli"), false);
  assert.equal(acceptsBrotli("*;q=1, identity;q=0"), true);
  assert.equal(acceptsBrotli("*, br;q=0"), false);
  assert.equal(acceptsBrotli("*;q=0"), false);
  assert.equal(acceptsBrotli(null), false);
  const h = (o) => new Headers(o);
  assert.equal(precondition(h({ "If-Match": "*" }), '"a"'), null);
  assert.equal(precondition(h({ "If-Unmodified-Since": new Date(0).toUTCString() }), '"a"', new Date(5000)), 412);
  assert.equal(precondition(h({ "If-Unmodified-Since": new Date(9000).toUTCString() }), '"a"', new Date(5000)), null);
  assert.equal(precondition(h({ "If-Match": '"a"', "If-Unmodified-Since": new Date(0).toUTCString() }), '"a"', new Date(5000)), null);
  assert.equal(precondition(h({ "If-Match": '"a"', "If-None-Match": '"a"' }), '"a"'), 304);
  assert.equal(precondition(h({ "If-Match": 'W/"a"' }), '"a"'), 412);
  assert.equal(precondition(h({ "If-None-Match": '"b", "a"' }), '"a"'), 304);
  assert.equal(precondition(h({ "If-None-Match": "*" }), '"a"'), 304);
  assert.equal(precondition(h({}), '"a"'), null);
});
