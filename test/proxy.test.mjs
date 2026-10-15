import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  browserCookie,
  upstreamCookies,
  cookieNamespace,
  previewProxy,
} from "../proxy.mjs";

test("old Meta Clinic session names remain separate by side and revision", () => {
  const original = cookieNamespace("original", "aaaaaaaaaaaa1111");
  const changed = cookieNamespace("changed", "bbbbbbbbbbbb2222");
  const cookies = `${browserCookie("_apply_session=base; Path=/; HttpOnly; SameSite=Lax", original).split(";")[0]}; ${browserCookie("_apply_session=candidate; Path=/; HttpOnly", changed).split(";")[0]}; unrelated=private`;
  assert.equal(upstreamCookies(cookies, original), "_apply_session=base");
  assert.equal(upstreamCookies(cookies, changed), "_apply_session=candidate");
  assert.equal(
    upstreamCookies(cookies, cookieNamespace("changed", "cccccccccccc3333")),
    "",
  );
  assert.equal(
    browserCookie(
      "_apply_session=x; Domain=localhost; Path=/; HttpOnly",
      original,
    ),
    `${original}_apply_session=x; Path=/; HttpOnly`,
  );
});

test("preview gateway rejects outside origins and forwards only its own cookies", async (t) => {
  let captured;
  const upstream = http.createServer((req, res) => {
    captured = req.headers;
    res.setHeader("Set-Cookie", "_apply_session=returned; Path=/; HttpOnly");
    res.end("preview");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const state = {
    status: "ready",
    original: { sha: "aaaaaaaaaaaa1111", scenario: {} },
  };
  const slot = { web: upstream.address().port, proxy: 0 };
  // Use a reserved ephemeral port for the explicit Host/Origin checks.
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  slot.proxy = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const proxy = previewProxy(
    "original",
    slot,
    () => state,
    "http://127.0.0.1:4310",
  );
  await new Promise((resolve) =>
    proxy.listen(slot.proxy, "127.0.0.1", resolve),
  );
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const origin = `http://127.0.0.1:${slot.proxy}`;
  assert.equal(
    (
      await fetch(origin, {
        method: "POST",
        headers: { Origin: "https://outside.example" },
      })
    ).status,
    403,
  );
  const prefix = cookieNamespace("original", state.original.sha);
  const response = await fetch(origin, {
    headers: { Cookie: `${prefix}_apply_session=ours; unrelated=secret` },
  });
  assert.equal(await response.text(), "preview");
  assert.equal(captured.cookie, "_apply_session=ours");
  assert.match(
    response.headers.get("set-cookie"),
    new RegExp(`^${prefix}_apply_session=`),
  );
  assert.equal(
    response.headers.get("content-security-policy"),
    "frame-ancestors http://127.0.0.1:4310",
  );
  state.status = "preparing";
  assert.equal((await fetch(origin)).status, 503);
});
