import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { acceptsBrotli, bodyInit, buildPath, filePath, parseState, precondition, resetPointers } from "../src/index.js";

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
  STATE: "current=v2\nprevious=v1\nchecked=v2\nfailed=\n",
  "builds/v2/index.html": "<html>v2</html>",
  "builds/v2/app-0123456789abcdef.js": "js2",
  "builds/v2/app-0123456789abcdef_bg.wasm": "wasm2",
  "builds/v2/app-0123456789abcdef_bg.wasm.br": "br2",
  "builds/v2/fonts/a.ttf": "font",
  "builds/v2/MANIFEST": "builds/v2/index.html\n",
  "builds/v1/index.html": "<html>v1</html>",
  "builds/v1/app-0123456789abcdef.js": "js1",
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

test("/ and other paths redirect into the current build without caching", async () => {
  for (const [from, to] of [["/", "/b/v2/"], ["/index.html", "/b/v2/"], ["/favicon.ico?x=1", "/b/v2/favicon.ico?x=1"]]) {
    const r = await get(from);
    assert.equal(r.status, 302, from);
    assert.equal(r.headers.get("Location"), to, from);
    assert.equal(r.headers.get("Cache-Control"), "no-store", from);
    assert.equal(r.headers.get("X-Current-Build"), "v2", from);
  }
  const bare = await get("/b/v1");
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get("Location"), "/b/v1/");
});

test("a build's files are served under its own path and never change", async () => {
  const page = await get("/b/v2/");
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<html>v2</html>");
  assert.equal(page.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("X-Build"), "v2");
  for (const p of ["/b/v2/app-0123456789abcdef.js", "/b/v2/fonts/a.ttf"]) {
    assert.equal((await get(p)).headers.get("Cache-Control"), "public, max-age=31536000, immutable", p);
  }
  assert.equal(page.headers.get("Cache-Control"), "no-cache");
  assert.equal((await get("/b/v2/fonts/a.ttf")).headers.get("Content-Type"), "font/ttf");
});

test("an older build keeps serving its own copy of a path the current build also has", async () => {
  const r = await get("/b/v1/app-0123456789abcdef.js");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "js1");
  assert.equal(r.headers.get("X-Build"), "v1");
});

test("wasm goes Brotli-compressed only to clients that accept br", async () => {
  const br = await get("/b/v2/app-0123456789abcdef_bg.wasm", { "Accept-Encoding": "gzip, br" });
  assert.equal(br.headers.get("Content-Encoding"), "br");
  assert.equal(br.headers.get("Content-Type"), "application/wasm");
  assert.equal(await br.text(), "br2");
  const plain = await get("/b/v2/app-0123456789abcdef_bg.wasm", { "Accept-Encoding": "gzip, br;q=0" });
  assert.equal(plain.headers.get("Content-Encoding"), null);
  assert.equal(await plain.text(), "wasm2");
  const rewritten = await get("/b/v2/app-0123456789abcdef_bg.wasm", { "Accept-Encoding": "br, gzip" }, "GET", { clientAcceptEncoding: "identity" });
  assert.equal(rewritten.headers.get("Content-Encoding"), null);
});

test("every response varies by Accept-Encoding", async () => {
  for (const p of ["/b/v2/", "/b/v2/app-0123456789abcdef.js", "/b/v2/fonts/a.ttf", "/b/v2/app-0123456789abcdef_bg.wasm"]) {
    assert.equal((await get(p)).headers.get("Vary"), "Accept-Encoding", p);
  }
});

test("a page of a deleted build goes back to / with its query, other misses are 404", async () => {
  const page = await get("/b/v0/?webgl&lang=fr");
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("Location"), "/?webgl&lang=fr");
  const miss = await get("/b/v2/missing.js");
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get("X-Build"), "v2");
  assert.equal((await get("/b/v1/missing.html")).status, 404);
  // A current build without index.html answers 404 instead of redirecting in a loop.
  delete env.SITE.files["builds/v2/index.html"];
  assert.equal((await get("/b/v2/")).status, 404);
});

test("the start page of a rolled-back build goes to the current build, its files stay", async () => {
  // A later failure (failed=v3) does not make v1's page loadable again.
  env.SITE.files.STATE = "current=v2\nprevious=v1\nchecked=v2\nfailed=v3\n";
  env.SITE.files["builds/v1/ROLLED_BACK"] = "";
  const r = await get("/b/v1/?webgl");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("Location"), "/?webgl");
  assert.equal((await get("/b/v1/app-0123456789abcdef.js")).status, 200);
  assert.equal((await get("/b/v1/ROLLED_BACK")).status, 404);
  assert.equal((await get("/b/v2/")).status, 200);
  // With the rolled-back build as the only one, its page answers 503.
  resetPointers();
  env.SITE.files.STATE = "current=v1\n";
  assert.equal((await get("/b/v1/")).status, 503);
  // A Worker that cached v1 as current before the rollback reads STATE again and redirects.
  env.SITE.files.STATE = "current=v2\nprevious=v1\nchecked=v2\nfailed=v1\n";
  const stale = await get("/b/v1/");
  assert.equal(stale.status, 302);
  assert.equal(stale.headers.get("Location"), "/");
});

test("only names ending in .wasm exactly get the Brotli copy", async () => {
  env.SITE.files["builds/v2/x.WASM"] = "plain";
  env.SITE.files["builds/v2/x.WASM.br"] = "other";
  const r = await get("/b/v2/x.WASM", { "Accept-Encoding": "br" });
  assert.equal(r.headers.get("Content-Encoding"), null);
  assert.equal(await r.text(), "plain");
});

test("conditional requests", async () => {
  const etag = '"builds/v2/fonts/a.ttf"';
  assert.equal((await get("/b/v2/fonts/a.ttf", { "If-None-Match": etag })).status, 304);
  assert.equal((await get("/b/v2/fonts/a.ttf", { "If-None-Match": `W/${etag}` }, "HEAD")).status, 304);
  assert.equal((await get("/b/v2/fonts/a.ttf", { "If-Match": '"other"' })).status, 412);
  assert.equal((await get("/b/v2/fonts/a.ttf", { "If-Match": etag })).status, 200);
  assert.equal((await get("/b/v2/fonts/a.ttf", { "If-Modified-Since": new Date(1000).toUTCString() })).status, 304);
  const h = await get("/b/v2/fonts/a.ttf", {}, "HEAD");
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("Content-Length"), "4");
  assert.equal(await h.text(), "");
});

test("other methods, dot and underscore files, MANIFEST and bad paths are refused", async () => {
  env.SITE.files["builds/v2/.htaccess"] = "x";
  env.SITE.files["builds/v2/_headers"] = "x";
  assert.equal((await get("/", {}, "POST")).status, 405);
  for (const p of ["/b/v2/.htaccess", "/b/v2/_headers", "/b/v2/MANIFEST", "/b/v2/a//b", "/b/v2/%E0%A4%A", "/b/..%2FSTATE/", "/b/%E0%A4%A/"]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test("filePath and buildPath refuse traversal and dot segments", () => {
  for (const p of ["/a/../b", "/../STATE", "/./index.html", "/a/./b", "/%2e%2e/STATE", "/a/%2E/b"]) {
    assert.equal(filePath(p), null, p);
  }
  assert.deepEqual(buildPath("/b/v1.20261123000000/x.js"), { id: "v1.20261123000000", rest: "/x.js" });
  assert.deepEqual(buildPath("/b/v1"), { id: "v1", rest: null });
  assert.equal(buildPath("/c/v1/"), null);
  assert.equal(buildPath("/b/../x").id, null);
});

test("a path whose key would pass R2's 1,024-byte limit is a 404 without an R2 call", async () => {
  const calls = [];
  const inner = env.SITE;
  env = { SITE: { get: (k) => (calls.push(k), inner.get(k)), head: (k) => (calls.push(k), inner.head(k)) } };
  assert.equal((await get(`/b/v2/${"a".repeat(1100)}.js`)).status, 404);
  assert.deepEqual(calls.filter((k) => k.startsWith("builds/")), []);
});

test("a Brotli body is sent as stored and a plain one may be compressed", () => {
  const h = new Headers();
  assert.equal(bodyInit(h, "br").encodeBody, "manual");
  assert.equal(bodyInit(h, null).encodeBody, "automatic");
});

test("no published build, an empty current or a damaged STATE answers 503 at /", async () => {
  for (const files of [{}, { STATE: "current=\nprevious=v1\n" }, { STATE: "current=v 2\n" }, { STATE: "garbage" }]) {
    resetPointers();
    env = { SITE: bucket(files) };
    assert.equal((await get("/")).status, 503, JSON.stringify(files));
  }
});

test("an R2 failure gives 503 without a cached id and the cached build with one", async () => {
  const inner = env.SITE;
  let failing = true;
  const guard = (f) => (k) => (failing ? Promise.reject(new Error("R2 down")) : f(k));
  env = { SITE: { get: guard((k) => inner.get(k)), head: guard((k) => inner.head(k)) } };
  assert.equal((await get("/")).status, 503);
  failing = false;
  assert.equal((await get("/")).headers.get("Location"), "/b/v2/");
  // With the cached id expired, a failed STATE read keeps using it.
  env = { SITE: { get: (k) => (k === "STATE" ? Promise.reject(new Error("R2 down")) : inner.get(k)), head: (k) => inner.head(k) } };
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    assert.equal((await get("/")).headers.get("Location"), "/b/v2/");
  } finally {
    Date.now = realNow;
  }
  resetPointers();
  assert.equal((await get("/")).status, 503);
  env = { SITE: { get: () => Promise.reject(new Error("R2 down")), head: () => Promise.reject(new Error("R2 down")) } };
  assert.equal((await get("/b/v2/fonts/a.ttf")).status, 503);
});

test("parseState", () => {
  assert.deepEqual(parseState("current=a\nprevious=b\nchecked=a\nfailed=c\n"), { current: "a", failed: "c" });
  assert.deepEqual(parseState(" current = a \r\nprevious=a\n"), { current: "a", failed: null });
  assert.deepEqual(parseState("current=a\nprevious=../x\n"), { current: null, failed: null });
});

test("acceptsBrotli and precondition", () => {
  assert.equal(acceptsBrotli("br"), true);
  assert.equal(acceptsBrotli("gzip, br;q=0.5"), true);
  assert.equal(acceptsBrotli("br;q=0, gzip"), false);
  assert.equal(acceptsBrotli("brotli"), false);
  assert.equal(acceptsBrotli(null), false);
  assert.equal(acceptsBrotli("*;q=1, identity;q=0"), true);
  assert.equal(acceptsBrotli("*, br;q=0"), false);
  const h = (o) => new Headers(o);
  assert.equal(precondition(h({ "If-Match": "*" }), '"a"'), null);
  assert.equal(precondition(h({ "If-Match": '"a"', "If-None-Match": '"a"' }), '"a"'), 304);
  assert.equal(precondition(h({ "If-Unmodified-Since": new Date(0).toUTCString() }), '"a"', new Date(5000)), 412);
  assert.equal(precondition(h({ "If-Match": 'W/"a"' }), '"a"'), 412);
  assert.equal(precondition(h({ "If-None-Match": '"b", "a"' }), '"a"'), 304);
  assert.equal(precondition(h({}), '"a"'), null);
});
