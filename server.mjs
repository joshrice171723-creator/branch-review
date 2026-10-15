import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  branches,
  comparison,
  git,
  root,
  repo,
  slots,
  state,
  startReview,
  stopReview,
  restoreReview,
} from "./adapter.mjs";
import { previewProxy } from "./proxy.mjs";

const port = 4310;
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString("hex");
let busy = false;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let buffer = "";
  for await (const chunk of req) {
    buffer += chunk;
    if (buffer.length > 16000) throw new Error("Request too large");
  }
  return JSON.parse(buffer || "{}");
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`)
      return json(res, 403, { error: "Invalid host" });
    const url = new URL(req.url, origin);
    if (req.method === "GET" && url.pathname === "/api/state")
      return json(res, 200, { ...state, busy, token, repository: repo });
    if (req.method === "GET" && url.pathname === "/api/branches")
      return json(res, 200, await branches());
    if (req.method === "GET" && url.pathname === "/api/comparison")
      return json(
        res,
        200,
        await comparison(
          url.searchParams.get("ref"),
          url.searchParams.get("baseline"),
        ),
      );
    if (
      req.method === "POST" &&
      ["/api/start", "/api/stop", "/api/fetch"].includes(url.pathname)
    ) {
      if (
        req.headers.origin !== origin ||
        req.headers["x-review-token"] !== token
      )
        return json(res, 403, {
          error: "Reload Branch Review before continuing.",
        });
      if (busy)
        return json(res, 409, {
          error: "Another preview operation is still running.",
        });
      const data = await body(req);
      if (url.pathname === "/api/start")
        await comparison(data.ref, data.baseline);
      busy = true;
      const operation =
        url.pathname === "/api/start"
          ? () => startReview(data.ref, data.baseline)
          : url.pathname === "/api/stop"
            ? stopReview
            : () => git("fetch", "origin");
      Promise.resolve()
        .then(operation)
        .catch((error) => {
          state.error = error.message;
          state.status = "error";
        })
        .finally(() => {
          busy = false;
        });
      return json(res, 202, { accepted: true });
    }
    if (
      req.method !== "GET" ||
      !["/", "/app.js", "/style.css"].includes(url.pathname)
    )
      return json(res, 404, { error: "Not found" });
    const filename =
      url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    res.writeHead(200, {
      "Content-Type": types[path.extname(filename)],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-src http://127.0.0.1:4311 http://127.0.0.1:4312; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    });
    res.end(await readFile(path.join(root, "public", filename)));
  } catch (error) {
    json(res, 400, { error: error.message });
  }
});
await restoreReview();
for (const [side, slot] of Object.entries(slots)) {
  const proxy = previewProxy(side, slot, () => state, origin);
  proxy.on("error", (error) => {
    console.error(`${side} preview proxy: ${error.message}`);
    process.exit(1);
  });
  proxy.listen(slot.proxy, "127.0.0.1");
}
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`Branch Review: ${origin}`));
