// Serves static web builds from the R2 bucket bound as SITE.
//
// Bucket layout (written by scripts/publish.sh):
//   builds/<id>/<path>       the files of one build
//   builds/<id>/<path>.br    a Brotli copy of each .wasm file
//   builds/<id>/MANIFEST     every key of the build, one per line
//   builds/<id>/ROLLED_BACK  present when the build failed its check and was rolled back
//   STATE                    lines current=<id>, previous=<id>, checked=<id> and failed=<id>
//   HISTORY                  the ids still kept, oldest first
//
// Every build is served under its own path, /b/<id>/, and a page loads its files through
// relative URLs, so a page and everything it loads always come from one build, in every tab and
// every cache. Any other path redirects to the same path in the current build: / goes to
// /b/<current>/. STATE is cached for 30 seconds.

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
const POINTER_TTL_MS = 30_000;
// R2 refuses keys longer than 1,024 bytes; such a key names no stored file.
const MAX_KEY_BYTES = 1024;
const encoder = new TextEncoder();

const EMPTY = { current: null, failed: null };
let pointer = { at: -Infinity, ...EMPTY };

export function resetPointers() {
  pointer = { at: -Infinity, ...EMPTY };
}

// Reads current= and failed= from a STATE text. A line that is not key=<id> makes the whole state
// unusable, so a damaged STATE gives 503 instead of a guess.
export function parseState(text) {
  const state = { ...EMPTY };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq < 0) return { ...EMPTY };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value !== "" && !ID.test(value)) return { ...EMPTY };
    if (key === "current" || key === "failed") state[key] = value || null;
  }
  return state;
}

// The parsed STATE, read again after POINTER_TTL_MS. When a read fails and a current id is
// cached, the cached state is used for another 5 seconds; with nothing cached, the error is thrown
// (the request then gets 503).
async function readState(bucket, now, fresh = false) {
  if (!fresh && now - pointer.at < POINTER_TTL_MS && pointer.current) return pointer;
  try {
    const obj = await bucket.get("STATE");
    pointer = { at: now, ...(obj ? parseState(await obj.text()) : EMPTY) };
  } catch (error) {
    if (!pointer.current) throw error;
    pointer = { ...pointer, at: now - POINTER_TTL_MS + 5_000 };
  }
  return pointer;
}

async function currentBuild(bucket, now) {
  return (await readState(bucket, now)).current;
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

// Splits /b/<id>/<rest> into the id and the rest ("/" + rest); null for any other path.
export function buildPath(pathname) {
  const m = pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return { id: null, rest: null };
  }
  return { id: ID.test(id) ? id : null, rest: m[2] ?? null };
}

function extension(path) {
  const base = path.split("/").pop();
  return base.includes(".") ? base.split(".").pop().toLowerCase() : "";
}

// A file under /b/<id>/ never changes its bytes: a republished build gets a new id. Pages are still
// revalidated, so a bookmarked page of a build that was deleted reaches the Worker and is sent to
// the current build.
function headersFor(path, obj, encoding, id) {
  const h = new Headers();
  const ext = extension(path);
  h.set("Content-Type", TYPES[ext] ?? "application/octet-stream");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Cache-Control", ext === "html" ? "no-cache" : "public, max-age=31536000, immutable");
  // Cloudflare compresses text responses on the way out, so every response varies by encoding.
  h.set("Vary", "Accept-Encoding");
  if (encoding) h.set("Content-Encoding", encoding);
  h.set("ETag", obj.httpEtag);
  if (obj.uploaded) h.set("Last-Modified", obj.uploaded.toUTCString());
  h.set("X-Build", id);
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
async function fromBuild(bucket, request, id, path) {
  const read = metadataFirst(request) ? (k) => bucket.head(k) : (k) => bucket.get(k);
  const key = `builds/${id}/${path}`;
  if (encoder.encode(key).length > MAX_KEY_BYTES) return null;
  // scripts/publish.sh makes .br copies for names ending in ".wasm" exactly.
  if (path.endsWith(".wasm") && acceptsBrotli(clientAcceptEncoding(request)) && encoder.encode(`${key}.br`).length <= MAX_KEY_BYTES) {
    const found = await read(`${key}.br`);
    if (found) return { key: `${key}.br`, meta: found, obj: "body" in found ? found : null, encoding: "br" };
  }
  const found = await read(key);
  return found ? { key, meta: found, obj: "body" in found ? found : null, encoding: null } : null;
}

function etagList(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 412 or 304 when the request's preconditions say so, else null (RFC 9110 section 13.2.2).
// If-Match compares strongly and If-None-Match weakly; If-Modified-Since and If-Unmodified-Since
// are used when there is no If-None-Match or If-Match.
export function precondition(headers, etag, uploaded) {
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
  const since = Date.parse(headers.get("If-Modified-Since") ?? "");
  if (seconds !== null && Number.isFinite(since) && seconds <= since) return 304;
  return null;
}

// The init for a response body: a body stored Brotli-compressed is sent as it is ("manual"), so
// the runtime does not compress it again.
export function bodyInit(headers, encoding) {
  return { headers, encodeBody: encoding ? "manual" : "automatic" };
}

function redirect(location, current = null) {
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (current) headers["X-Current-Build"] = current;
  return new Response(null, { status: 302, headers });
}

// A 404 for a file under /b/<id>/ names the build in X-Build, so a check can tell this Worker's
// answer from one that does not know the path layout.
const notFound = (id = null) => new Response("Not found\n", { status: 404, headers: id ? { "X-Build": id } : {} });

async function serve(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const build = buildPath(url.pathname);

  if (!build) {
    // Any other path goes to the same path in the current build.
    const current = await currentBuild(env.SITE, Date.now());
    if (!current) return new Response("No build has been published yet\n", { status: 503, headers: { "Retry-After": "300", "Cache-Control": "no-store" } });
    const rest = url.pathname === "/index.html" ? "/" : url.pathname;
    return redirect(`/b/${encodeURIComponent(current)}${rest}${url.search}`, current);
  }
  if (!build.id) return notFound();
  if (build.rest === null) return redirect(`/b/${encodeURIComponent(build.id)}/${url.search}`);

  const path = filePath(build.rest);
  // MANIFEST at the top of a build is the bucket's own list of keys, not a site file.
  if (!path || path === "MANIFEST") return notFound();

  // ROLLED_BACK at the top of a build marks a build that failed its check (scripts/rollback.sh
  // writes it). Its start page goes to the current build, so reloading such a tab recovers, or
  // answers 503 when no other build is served; the build's other files stay available to pages
  // that are already running.
  if (path === "ROLLED_BACK") return notFound();
  if (path === "index.html" && (await env.SITE.head(`builds/${build.id}/ROLLED_BACK`))) {
    let current = await currentBuild(env.SITE, Date.now());
    // A cached id that names the rolled-back build is out of date: read STATE again.
    if (current === build.id) current = (await readState(env.SITE, Date.now(), true)).current;
    if (current && current !== build.id) return redirect(`/${url.search}`);
    return new Response("This build failed its check and no other build is published\n", { status: 503, headers: { "Retry-After": "300", "Cache-Control": "no-store" } });
  }

  const found = await fromBuild(env.SITE, request, build.id, path);
  if (!found) {
    // A page of a build that was deleted (no index.html left, and not the current build) goes to
    // the current build with the same query; any other missing file is a 404.
    if (extension(path) === "html" && !(await env.SITE.head(`builds/${build.id}/index.html`))) {
      const current = await currentBuild(env.SITE, Date.now());
      if (current && current !== build.id) return redirect(`/${url.search}`);
    }
    return notFound(build.id);
  }

  const { key, meta, encoding } = found;
  let obj = found.obj;
  const headers = headersFor(path, meta, encoding, build.id);
  const status = precondition(request.headers, meta.httpEtag, meta.uploaded);
  if (status === 412) return new Response(null, { status, headers: { "X-Build": build.id } });
  if (status === 304) return new Response(null, { status, headers });
  headers.set("Content-Length", String(meta.size));
  if (request.method === "HEAD") return new Response(null, { headers });

  obj ??= await env.SITE.get(key);
  if (!obj) return notFound();
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
      return new Response("The site is not available right now\n", { status: 503, headers: { "Retry-After": "30" } });
    }
  },
};
