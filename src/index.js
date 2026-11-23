// Serves one static web build from the R2 bucket bound as SITE.
//
// Bucket layout (written by scripts/publish.sh):
//   builds/<id>/<path>       the files of one build
//   builds/<id>/<path>.br    a Brotli copy of each .wasm file
//   builds/<id>/MANIFEST     every key of the build, one per line
//   STATE                    lines current=<id>, previous=<id> and checked=<id>
//   HISTORY                  the ids still kept, oldest first
//
// A request is answered from the current build. A file missing there is looked up in the previous
// build, so a page loaded just before a switch can still fetch the hashed files it names. STATE is
// cached for 30 seconds; a file found in neither build makes the Worker read it again.

const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
  css: "text/css; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASHED = /-[0-9a-f]{16}(_bg)?\.(js|wasm)$/;
const POINTER_TTL_MS = 30_000;

let pointers = { at: -Infinity, current: null, previous: null };

export function resetPointers() {
  pointers = { at: -Infinity, current: null, previous: null };
}

// Reads current= and previous= from a STATE text. A line that is not key=<id> makes the whole
// state unusable, so a damaged STATE gives 503 instead of a guess.
export function parseState(text) {
  const state = { current: null, previous: null };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq < 0) return { current: null, previous: null };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value !== "" && !ID.test(value)) return { current: null, previous: null };
    if (key === "current" || key === "previous") state[key] = value || null;
  }
  if (state.previous === state.current) state.previous = null;
  return state;
}

// The current and previous ids, read again after POINTER_TTL_MS or when `fresh` is set. When an
// expired read fails and ids are cached, the cached ids are used for another 5 seconds; with nothing
// cached, or when a `fresh` read fails, the error is thrown (the request then gets 503).
async function builds(bucket, now, fresh = false) {
  if (!fresh && now - pointers.at < POINTER_TTL_MS && pointers.current) return pointers;
  let state;
  try {
    const obj = await bucket.get("STATE");
    state = obj ? parseState(await obj.text()) : { current: null, previous: null };
  } catch (error) {
    // A forced read that fails cannot show a file is absent, so the caller answers 503.
    if (!pointers.current || fresh) throw error;
    pointers = { ...pointers, at: now - POINTER_TTL_MS + 5_000 };
    return pointers;
  }
  pointers = { at: now, ...state };
  return pointers;
}

// Returns the file path a URL path names, or null when it names no file that may be served.
export function filePath(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (path.includes("\\") || path.includes("\0")) return null;
  if (path === "" || path.endsWith("/")) path += "index.html";
  const parts = path.split("/").slice(1);
  if (parts.length === 0 || parts.some((p) => p === "" || p.startsWith(".") || p.startsWith("_"))) return null;
  return parts.join("/");
}

function headersFor(path, obj, encoding) {
  const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
  const h = new Headers();
  h.set("Content-Type", TYPES[ext] ?? "application/octet-stream");
  h.set("X-Content-Type-Options", "nosniff");
  // Hashed names never change their bytes. Pages and scripts without a hash are revalidated on
  // every load, since the page checks scripts against integrity values; other files keep an hour.
  if (HASHED.test(path)) h.set("Cache-Control", "public, max-age=31536000, immutable");
  else if (["html", "js", "mjs", "wasm"].includes(ext)) h.set("Cache-Control", "no-cache");
  else h.set("Cache-Control", "public, max-age=3600");
  // Cloudflare compresses text responses on the way out, so every response varies by encoding.
  h.set("Vary", "Accept-Encoding");
  if (encoding) h.set("Content-Encoding", encoding);
  h.set("ETag", obj.httpEtag);
  if (obj.uploaded) h.set("Last-Modified", obj.uploaded.toUTCString());
  return h;
}

// True when an Accept-Encoding value accepts br: an explicit br entry with a nonzero quality, or,
// without a br entry, a * entry with a nonzero quality (RFC 9110 section 12.5.3).
export function acceptsBrotli(value) {
  let star = null;
  for (const item of (value ?? "").split(",")) {
    const [name, ...params] = item.split(";").map((s) => s.trim().toLowerCase());
    const q = params.find((p) => p.startsWith("q="));
    const n = q ? Number(q.slice(2)) : 1;
    const ok = Number.isFinite(n) && n > 0;
    if (name === "br") return ok;
    if (name === "*") star = ok;
  }
  return star === true;
}

// The Accept-Encoding the client sent. Cloudflare can replace the header a Worker sees, and keeps
// the original in request.cf.clientAcceptEncoding.
function clientAcceptEncoding(request) {
  return request.cf?.clientAcceptEncoding ?? request.headers.get("Accept-Encoding");
}

// True when the response can be decided without the body: HEAD, or a request with preconditions.
function metadataFirst(request) {
  const h = request.headers;
  return request.method === "HEAD" || ["If-None-Match", "If-Match", "If-Modified-Since", "If-Unmodified-Since"].some((n) => h.has(n));
}

// Finds the stored object for a path in one build: its key, metadata (`meta`), encoding and, for an
// ordinary GET, the object with its body (`obj`), so that GET costs one R2 read.
// R2 refuses keys longer than 1,024 bytes; such a key names no stored file.
const MAX_KEY_BYTES = 1024;
const encoder = new TextEncoder();

async function fromBuild(bucket, request, id, path) {
  const read = metadataFirst(request) ? (k) => bucket.head(k) : (k) => bucket.get(k);
  const key = `builds/${id}/${path}`;
  if (encoder.encode(key).length > MAX_KEY_BYTES) return null;
  if (path.endsWith(".wasm") && acceptsBrotli(clientAcceptEncoding(request)) && encoder.encode(`${key}.br`).length <= MAX_KEY_BYTES) {
    const found = await read(`${key}.br`);
    if (found) return { key: `${key}.br`, meta: found, obj: "body" in found ? found : null, encoding: "br", id };
  }
  const found = await read(key);
  return found ? { key, meta: found, obj: "body" in found ? found : null, encoding: null, id } : null;
}

async function findIn(bucket, request, path, ids, tried) {
  for (const id of ids) {
    if (!id || tried.has(id)) continue;
    tried.add(id);
    const found = await fromBuild(bucket, request, id, path);
    if (found) return found;
  }
  return null;
}

// Looks in the current build, then (except for .html) the previous one. When neither has the
// file, STATE is read again and only builds not tried yet are searched.
async function find(bucket, request, path) {
  const tried = new Set();
  let current = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ids = await builds(bucket, Date.now(), attempt > 0);
    current = ids.current;
    if (!current) return { none: true };
    const html = path.toLowerCase().endsWith(".html");
    const found = await findIn(bucket, request, path, html ? [current] : [current, ids.previous], tried);
    if (found) return { ...found, current };
  }
  return { missing: true, current };
}

function etagList(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 412 or 304 when the request's preconditions say so, else null (RFC 9110 section 13.2.2).
// If-Match compares strongly and If-None-Match weakly. If-Modified-Since is used only when there is
// no If-None-Match, and only for hashed file names (`dated`): after a rollback the served copy of
// any other file is older than the one a browser may hold, so a date would wrongly confirm it.
export function precondition(headers, etag, uploaded, dated = true) {
  const seconds = uploaded ? Math.floor(uploaded.getTime() / 1000) * 1000 : null;
  const ifMatch = headers.get("If-Match");
  if (ifMatch !== null) {
    const list = etagList(ifMatch);
    if (!list.includes("*") && !list.includes(etag)) return 412;
  } else {
    const before = Date.parse(headers.get("If-Unmodified-Since") ?? "");
    if (seconds !== null && Number.isFinite(before) && seconds > before) return 412;
  }
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    const weak = (t) => t.replace(/^W\//, "");
    const list = etagList(ifNoneMatch).map(weak);
    return list.includes("*") || list.includes(weak(etag)) ? 304 : null;
  }
  if (!dated) return null;
  const since = Date.parse(headers.get("If-Modified-Since") ?? "");
  if (seconds !== null && Number.isFinite(since) && seconds <= since) return 304;
  return null;
}

// The init for a response body: a body stored Brotli-compressed is sent as it is ("manual"), so
// the runtime does not compress it again.
export function bodyInit(headers, encoding) {
  return { headers, encodeBody: encoding ? "manual" : "automatic" };
}

function unavailable() {
  return new Response("The site is not available right now\n", { status: 503, headers: { "Retry-After": "30" } });
}

async function serve(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const path = filePath(url.pathname);
  // MANIFEST at the top of a build is the bucket's own list of keys, not a site file.
  if (!path || path === "MANIFEST") return new Response("Not found\n", { status: 404 });

  const found = await find(env.SITE, request, path);
  if (found.none) return new Response("No build has been published yet\n", { status: 503, headers: { "Retry-After": "300" } });
  if (found.missing) return new Response("Not found\n", { status: 404, headers: { "X-Current-Build": found.current } });

  const { key, meta, encoding, id } = found;
  let obj = found.obj;
  const headers = headersFor(path, meta, encoding);
  headers.set("X-Build", id);
  // The build this Worker treats as current; it differs from X-Build when the file came from the
  // previous build.
  headers.set("X-Current-Build", found.current);
  const status = precondition(request.headers, meta.httpEtag, meta.uploaded, HASHED.test(path));
  if (status === 412) return new Response(null, { status, headers: { "X-Build": id } });
  if (status === 304) return new Response(null, { status, headers });
  headers.set("Content-Length", String(meta.size));
  if (request.method === "HEAD") return new Response(null, { headers });

  obj ??= await env.SITE.get(key);
  if (!obj) return new Response("Not found\n", { status: 404 });
  if (obj.httpEtag !== meta.httpEtag) {
    headers.set("ETag", obj.httpEtag);
    headers.set("Content-Length", String(obj.size));
  }
  return new Response(obj.body, bodyInit(headers, encoding));
}

export default {
  async fetch(request, env) {
    try {
      return await serve(request, env);
    } catch (error) {
      console.error("request failed", error);
      return unavailable();
    }
  },
};
