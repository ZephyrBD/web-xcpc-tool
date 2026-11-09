// Debug-only relay: local HTTP -> DOMjudge official demo over HTTPS.
// Exists because bun.exe is RST-blocked for domjudge.org on some machines; node.exe is not.
// Usage: node script/debug/relay-domjudge-demo.mjs [listenPort]   (default 9090)
import http from "node:http";

const LISTEN = Number(process.argv[2] ?? 9090);
const UPSTREAM = "https://www.domjudge.org";
const PREFIX = "/demoweb";

http
  .createServer(async (req, res) => {
    const t0 = Date.now();
    if (req.method === "POST") {
      console.log("POST HEADERS:", JSON.stringify(req.headers, null, 0));
      const clone = req.clone ? null : null;
    }
    console.log(new Date().toISOString(), "<-", req.method, req.url,
      req.headers["x-domjudge-login"] ? `[xlogin=${req.headers["x-domjudge-login"]}]` : "[no-xlogin]");
    try {
      // Demo quirk: absolute redirects/links like /demoweb/public only work at
      // the real domain. Accept /demoweb/* passthrough and rewrite redirect
      // Locations back to root-relative so the local root proxy stays usable.
      const incoming = req.url.startsWith(PREFIX + "/") || req.url === PREFIX
        ? req.url.slice(PREFIX.length) || "/"
        : req.url;
      const target = new URL(PREFIX + incoming, UPSTREAM);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      const body = ["GET", "HEAD"].includes(req.method)
        ? undefined
        : await new Response(req).arrayBuffer();
      const r = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
      });
      const outHeaders = new Headers(r.headers);
      const loc = outHeaders.get("location");
      if (loc && loc.startsWith(PREFIX + "/")) outHeaders.set("location", loc.slice(PREFIX.length));
      outHeaders.delete("transfer-encoding");
      outHeaders.delete("content-encoding");
      outHeaders.delete("content-length");
      res.writeHead(r.status, Object.fromEntries(outHeaders));
      if (r.body) for await (const chunk of r.body) res.write(chunk);
      res.end();
    } catch (err) {
      console.error(new Date().toISOString(), req.method, req.url, "->", String(err?.cause?.code || err));
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: String(err?.cause?.code || err) }));
    }
  })
  .listen(LISTEN, "127.0.0.1", () =>
    console.log(`demo relay: 127.0.0.1:${LISTEN} -> ${UPSTREAM}${PREFIX}`)
  );
