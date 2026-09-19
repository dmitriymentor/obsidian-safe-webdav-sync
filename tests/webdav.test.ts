import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";

const code = buildSync({ entryPoints: ["src/webdav.ts"], bundle: true, write: false, format: "cjs", platform: "browser", external: ["obsidian"] }).outputFiles[0]!.text;
type Node = { name: string; text?: string; children?: Node[] };
class Element {
  constructor(private node: Node) {}
  get textContent() { return this.node.text ?? ""; }
  getElementsByTagNameNS(_namespace: string, name: string) { return this.getElementsByTagName(name); }
  getElementsByTagName(name: string) {
    const out: Element[] & { item?: (n: number) => Element | null } = [];
    const visit = (node: Node) => { for (const child of node.children ?? []) { if (child.name === name) out.push(new Element(child)); visit(child); } };
    visit(this.node); out.item = n => out[n] ?? null; return out;
  }
}
class DOMParser { parseFromString(s: string) { return new Element(JSON.parse(s)); } }
function response(paths: string[]) {
  return JSON.stringify({ name: "document", children: [{ name: "multistatus", children: paths.map(p => ({ name: "response", children: [
    { name: "href", text: "/vault/" + p }, { name: "getetag", text: '"etag"' },
    { name: "getcontentlength", text: "123" }, { name: "getlastmodified", text: "Sat, 19 Sep 2026 10:00:00 GMT" },
    ...(p.endsWith("/") ? [{ name: "collection" }] : [])
  ] })) }] });
}
function fixture(fail?: string) {
  const graph: Record<string, string[]> = { "": ["a/", "b/", "c/", "d/", "e/", "excluded/", "root.md"],
    a: ["a/", "a/sub/", "a/note.md"], b: ["b/", "a/sub/", "b/note.md"], c: ["c/note.md"], d: [], e: [], "a/sub": ["a/sub/deep.md"] };
  let active = 0, maximum = 0;
  const calls: string[] = [];
  const requestUrl = async (args: any) => {
    assert.equal(args.method, "PROPFIND"); assert.equal(args.headers.Depth, "1");
    const p = new URL(args.url).pathname.replace(/^\/vault\//, "").replace(/\/$/, "");
    calls.push(p); active++; maximum = Math.max(maximum, active);
    try { await new Promise(r => setTimeout(r, p === fail ? 1 : 8)); return { status: p === fail ? 503 : 207, text: response(graph[p] ?? []) }; }
    finally { active--; }
  };
  const module = { exports: {} as any };
  runInNewContext(code, { module, exports: module.exports, require: () => ({ requestUrl }), DOMParser, URL, setTimeout });
  const webdav = new module.exports.WebDav("https://example.test", "user", "pass", "vault");
  return { webdav, calls, active: () => active, maximum: () => maximum };
}
test("directory listing scans the complete tree with at most four concurrent reads", async () => {
  const f = fixture(), progress: [number, number][] = [];
  const result = await f.webdav.list((done: number, total: number) => progress.push([done, total]), async (p: string) => p !== "excluded");
  assert.equal(f.maximum(), 4);
  assert.equal(f.active(), 0);
  assert.equal(f.calls.length, 7);
  assert.equal(new Set(f.calls).size, 7);
  assert.equal(f.calls.includes("excluded"), false);
  assert.ok(result.some((e: any) => e.encryptedPath === "a/sub/deep.md"));
  assert.ok(result.some((e: any) => e.encryptedPath === "b/note.md"));
  assert.deepEqual(progress.map(p => p[0]), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(progress.every(([done, total]) => done <= total));
  assert.deepEqual(progress.at(-1), [7, 7]);
});
test("a failed directory aborts the entire index and drains outstanding requests", async () => {
  const f = fixture("a");
  await assert.rejects(f.webdav.list(undefined, async (p: string) => p !== "excluded"), /503/);
  assert.equal(f.active(), 0);
  assert.equal(f.calls.includes("e"), false);
  assert.equal(f.calls.includes("a/sub"), false);
});

function objectFixture(requestUrl: (args: any) => Promise<any>) {
  const module = { exports: {} as any };
  const delays: number[] = [];
  runInNewContext(code, { module, exports: module.exports, require: () => ({ requestUrl }), DOMParser, URL,
    setTimeout: (callback: () => void, delay: number) => { delays.push(delay); callback(); } });
  return { webdav: new module.exports.WebDav("https://example.test", "user", "pass", "vault"), delays };
}
test("GET and PUT accept all HTTP header casing, including Etag used by native transports", async () => {
  for (const name of ["etag", "ETag", "Etag", "ETAG", "eTaG"]) {
    const content = new TextEncoder().encode("current bytes").buffer;
    const f = objectFixture(async args => ({ status: args.method === "PUT" ? 201 : 200, headers: { [name]: '  "revision"  ' }, arrayBuffer: content }));
    assert.equal((await f.webdav.getObject("note.md")).etag, '"revision"');
    assert.equal(await f.webdav.put("note.md", content), '"revision"');
  }
});
test("native-cased weak Etag retries fresh bytes, never upgrades a weak validator", async () => {
  let reads = 0;
  const f = objectFixture(async () => ({ status: 200, headers: { Etag: ++reads === 1 ? 'W/"old"' : '"fresh"' }, arrayBuffer: new TextEncoder().encode(String(reads)).buffer }));
  const object = await f.webdav.getObject("note.md");
  assert.equal(reads, 2); assert.equal(object.etag, '"fresh"');
  assert.equal(new TextDecoder().decode(object.bytes), "2"); assert.deepEqual(f.delays, [1500]);
  const weak = objectFixture(async () => ({ status: 200, headers: { Etag: 'W/"weak"' }, arrayBuffer: new ArrayBuffer(0) }));
  assert.equal((await weak.webdav.getObject("note.md")).etag, 'W/"weak"');
  await assert.rejects(weak.webdav.removeIfMatch("note.md", 'W/"weak"'), /ETag/);
});
test("missing and contradictory ETag headers cannot authorize a conditional deletion", async () => {
  for (const headers of [{}, { Etag: '"one"', etag: '"two"' }]) {
    const f = objectFixture(async args => {
      assert.equal(args.method, "GET");
      return { status: 200, headers, arrayBuffer: new ArrayBuffer(0) };
    });
    const object = await f.webdav.getObject("note.md");
    assert.equal(object.etag, "");
    await assert.rejects(f.webdav.removeIfMatch("note.md", object.etag), /ETag/);
  }
});

test("all GETs bypass stale native caches after PUT and keep validators paired with bytes", async () => {
  const old = new TextEncoder().encode("old").buffer;
  const fresh = new TextEncoder().encode("fresh").buffer;
  let server = old, revision = '"old"';
  const cache = new Map<string, any>();
  const reads: string[] = [];
  const f = objectFixture(async args => {
    const url = new URL(args.url);
    assert.equal(url.pathname, "/vault/note.md");
    if (args.method === "GET") {
      assert.equal(args.headers["Cache-Control"], "no-cache, no-store, max-age=0");
      assert.equal(args.headers.Pragma, "no-cache");
      assert.ok(url.searchParams.get("safe-sync-read"));
      reads.push(args.url);
      // Model a native cache that ignores headers and retains pre-PUT bodies.
      if (!cache.has(args.url)) cache.set(args.url, { status: 200, headers: { Etag: revision }, arrayBuffer: server });
      return cache.get(args.url);
    }
    assert.equal(url.search, "");
    assert.equal(args.method, "PUT");
    assert.equal(args.headers["If-Match"], revision);
    server = args.body; revision = '"fresh"';
    return { status: 204, headers: { Etag: revision } };
  });
  const before = await f.webdav.getObject("note.md");
  assert.equal(new TextDecoder().decode(before.bytes), "old");
  await f.webdav.put("note.md", fresh, { "If-Match": before.etag });
  const after = await f.webdav.getObject("note.md");
  assert.equal(new TextDecoder().decode(after.bytes), "fresh");
  assert.equal(after.etag, '"fresh"');
  assert.equal(new TextDecoder().decode(await f.webdav.get("note.md")), "fresh");
  assert.equal(new Set(reads).size, 3);
});

test("weak validator retries also use distinct cache keys", async () => {
  const urls: string[] = [];
  const f = objectFixture(async args => {
    urls.push(args.url);
    return { status: 200, headers: { Etag: urls.length === 1 ? 'W/"one"' : '"two"' }, arrayBuffer: new ArrayBuffer(0) };
  });
  assert.equal((await f.webdav.getObject("note.md")).etag, '"two"');
  assert.equal(new Set(urls).size, 2);
});

test("unexpected 304 is not accepted as an object or retried as an unconditional write", async () => {
  const f = objectFixture(async args => { assert.equal(args.method, "GET"); return { status: 304, headers: {} }; });
  await assert.rejects(f.webdav.getObject("note.md"), /HTTP 304/);
  await assert.rejects(f.webdav.get("note.md"), /HTTP 304/);
});

test("overlong encrypted names fail clearly before creating directories or uploading", async () => {
  const f = objectFixture(async () => { assert.fail("no network request should be made"); });
  await assert.rejects(f.webdav.put("folder/" + "a".repeat(256), new ArrayBuffer(0)), /Слишком длинное имя/);
  await assert.rejects(f.webdav.get("я".repeat(128)), /255 байт/);
});
