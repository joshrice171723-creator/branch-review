import http from "node:http";
import { scrollBridge } from './scroll-bridge.mjs';
import { defaultManifest, scenarioPath } from './reviews.mjs';

export function cookieNamespace(side, sha) {
  return `br_${side}_${sha.slice(0, 12)}_`;
}
export function upstreamCookies(header = "", prefix) {
  return header
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(prefix))
    .map((s) => s.slice(prefix.length))
    .join("; ");
}
export function browserCookie(cookie, prefix) {
  return prefix + cookie.replace(/;\s*Domain=[^;]+/gi, "");
}
const escapeJSON = (data) => JSON.stringify(data).replace(/</g, "\\u003c");

export function previewProxy(side, slot, getState, appOrigin) {
  const origin = `http://127.0.0.1:${slot.proxy}`;
  const allowedHost = `127.0.0.1:${slot.proxy}`;
  const upstream = `127.0.0.1:${slot.web}`;
  function headers(req, preview) {
    const result = {
      ...req.headers,
      host: upstream,
      'accept-encoding': 'identity',
      cookie: upstreamCookies(
        req.headers.cookie,
        cookieNamespace(side, preview.sha),
      ),
    };
    delete result["forwarded"];
    delete result["x-forwarded-host"];
    if (result.origin === origin) result.origin = `http://${upstream}`;
    if (result.referer?.startsWith(origin + "/"))
      result.referer = result.referer.replace(origin, `http://${upstream}`);
    return result;
  }
  const server = http.createServer((req, res) => {
    if (req.headers.host !== allowedHost) {
      res.writeHead(403).end("Invalid host");
      return;
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin !== origin
    ) {
      res.writeHead(403).end("Invalid origin");
      return;
    }
    const current = getState();
    const preview = current[side];
    if (current.status !== "ready" || !preview) {
      res.writeHead(503).end("Preview is not ready. Return to Branch Review.");
      return;
    }
    const url = new URL(req.url, origin);
    if (url.pathname === "/__review/start") {
      const manifest = current.manifest || defaultManifest;
      const scenario = manifest.scenarios.find(s => s.id === (url.searchParams.get('scenario') || manifest.scenarios[0].id));
      if (!scenario) return res.writeHead(400).end('Unknown test scenario');
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `frame-ancestors ${appOrigin}`,
      });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Open intake</title></head><body style="font:16px Segoe UI;padding:40px;color:#283a39"><p id="status">Opening Jordan’s intake…</p><script>
        const scenario = ${escapeJSON({...preview.scenario, path: scenarioPath(scenario, preview.scenario)})};
        (async () => {
          if (scenario.public === true) { location.replace(scenario.path); return; }
          const csrf = await fetch('/api/csrf').then(async r => { if (!r.ok) throw Error('Could not establish a session.'); return r.json(); });
          const response = await fetch('/api/development_session', { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.csrf_token}, body:JSON.stringify(scenario) });
          if (!response.ok) { const data = await response.json(); throw Error(data.error || 'Could not sign in to the review clinic.'); }
          location.replace(scenario.path);
        })().catch(error => { document.getElementById('status').textContent = error.message; parent.postMessage({type:'review:error',side:${escapeJSON(side)},message:error.message},${escapeJSON(appOrigin)}); });
      </script></body></html>`);
      return;
    }
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: slot.web,
        method: req.method,
        path: req.url,
        headers: headers(req, preview),
      },
      (response) => {
        const result = { ...response.headers };
        if (result["set-cookie"])
          result["set-cookie"] = result["set-cookie"].map((c) =>
            browserCookie(c, cookieNamespace(side, preview.sha)),
          );
        // This loopback-only preview may be embedded only by its review shell.
        delete result["x-frame-options"];
        result["content-security-policy"] = `frame-ancestors ${appOrigin}`;
        if (result.location?.startsWith(`http://${upstream}/`))
          result.location = result.location.replace(
            `http://${upstream}`,
            origin,
          );
        if (req.method === 'GET' && result['content-type']?.includes('text/html') && !result['content-encoding']) {
          delete result['content-length'];
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            const observer = `<script>(()=>{const errors=[];const report=()=>parent.postMessage({type:'review:context',location:location.pathname+location.search+location.hash,errors},${escapeJSON(appOrigin)});addEventListener('error',e=>{errors.push(String(e.message).slice(0,500));if(errors.length>10)errors.shift();report()});addEventListener('unhandledrejection',e=>{errors.push(String(e.reason).slice(0,500));if(errors.length>10)errors.shift();report()});setInterval(report,1500);report()})()</script>`;
            res.writeHead(response.statusCode, result);
            const scrolling = `<script>(${scrollBridge.toString()})(${escapeJSON(appOrigin)})</script>`;
            res.end(Buffer.concat(chunks).toString().replace('</head>', observer + scrolling + '</head>'));
          });
          response.on('error', () => res.destroy());
        } else { res.writeHead(response.statusCode, result); response.pipe(res); }
      },
    );
    request.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("Preview stopped. Reopen the review to restart it.");
    });
    req.pipe(request);
  });
  server.on("upgrade", (req, socket, head) => {
    const current = getState();
    const preview = current[side];
    if (
      req.headers.host !== allowedHost ||
      req.headers.origin !== origin ||
      !preview ||
      current.status !== "ready"
    )
      return socket.destroy();
    const request = http.request({
      hostname: "127.0.0.1",
      port: slot.web,
      path: req.url,
      headers: headers(req, preview),
    });
    request.on("upgrade", (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      remote.pipe(socket);
      socket.pipe(remote);
      remote.on("error", () => socket.destroy());
      socket.on("error", () => remote.destroy());
    });
    request.on("error", () => socket.destroy());
    request.end();
  });
  return server;
}
