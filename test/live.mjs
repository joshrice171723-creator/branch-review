// Runs against the owned preview pair; writes and restores one synthetic draft answer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const state = await fetch("http://127.0.0.1:4310/api/state").then((r) =>
  r.json(),
);
assert.equal(
  state.status,
  "ready",
  "Open a review before running live checks.",
);
assert.notEqual(state.original.database, state.changed.database);
assert.notEqual(state.original.api, state.changed.api);
const jar = new Map();
const sessions = {};
async function request(side, path, data) {
  const origin = `http://127.0.0.1:${state[side].proxy}`;
  const session = sessions[side] || {};
  const response = await fetch(origin + path, {
    method: data ? "POST" : "GET",
    signal: AbortSignal.timeout(60000),
    headers: {
      Origin: origin,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      ...(data
        ? { "Content-Type": "application/json", "X-CSRF-Token": session.csrf }
        : {}),
      ...(session.actor
        ? {
            "X-Clinic-Actor": String(session.actor),
            "X-Clinic-Practice": String(state[side].scenario.practice_id),
          }
        : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  for (const cookie of response.headers.getSetCookie()) {
    const item = cookie.split(";")[0];
    const i = item.indexOf("=");
    jar.set(item.slice(0, i), item.slice(i + 1));
  }
  const text = await response.text();
  assert.equal(
    response.ok,
    true,
    `${side} ${path}: ${response.status} ${text.slice(0, 800)}`,
  );
  return JSON.parse(text);
}
const paths = {};
for (const side of ["original", "changed"]) {
  const csrf = await request(side, "/api/csrf");
  sessions[side] = { csrf: csrf.csrf_token };
  const login = await request(
    side,
    "/api/development_session",
    state[side].scenario,
  );
  sessions[side].actor = login.user.id;
  sessions[side].csrf = (await request(side, "/api/csrf")).csrf_token;
  paths[side] = "/api" + state[side].scenario.path.split("#")[0];
}
const original = await request("original", paths.original + "/nurse_workspace");
const changed = await request("changed", paths.changed + "/nurse_workspace");
assert.ok(original.intake.questionnaire.answers.visit_reason.value);
assert.ok(changed.capabilities.intake_write);
const oldValue = changed.intake.questionnaire.answers.visit_reason.value;
async function save(workspace, value) {
  const intake = workspace.intake;
  const q = structuredClone(intake.questionnaire);
  q.answers.visit_reason.value = value;
  const result = await request("changed", paths.changed + "/intake_revisions", {
    intake: {
      status: intake.status,
      identity_state: intake.identity_state,
      visit_reason_state: intake.visit_reason_state,
      history_state: intake.history_state,
      vitals_state: intake.vitals_state,
      expected_version: intake.version,
      request_key: randomUUID(),
      observation_ids: [],
      history_review_ids: [],
      questionnaire: {
        text: q.text,
        answers: q.answers,
        status: "draft",
        confirmed: false,
        confirmed_chunks: q.confirmed_chunks || [],
      },
    },
  });
  return result;
}
const marker = `Review isolation check ${randomUUID()}`;
await save(changed, marker);
try {
  const persisted = await request(
    "changed",
    paths.changed + "/nurse_workspace",
  );
  const untouched = await request(
    "original",
    paths.original + "/nurse_workspace",
  );
  assert.equal(
    persisted.intake.questionnaire.answers.visit_reason.value,
    marker,
  );
  assert.equal(untouched.intake.version, original.intake.version);
  assert.equal(
    untouched.intake.questionnaire.answers.visit_reason.value,
    original.intake.questionnaire.answers.visit_reason.value,
  );
  console.log(
    "PASS: Both preview logins coexist in one cookie jar; seeded intake loads; Changed saves and persists; Original remains unchanged.",
  );
} finally {
  await save(
    await request("changed", paths.changed + "/nurse_workspace"),
    oldValue,
  );
}
const denied = await fetch("http://127.0.0.1:4310/api/stop", {
  method: "POST",
  headers: {
    Origin: "https://outside.example",
    "Content-Type": "application/json",
  },
  body: "{}",
});
assert.equal(denied.status, 403);
console.log(
  `PASS: Outside-origin control request rejected. Original ${state.original.sha.slice(0, 7)} / Changed ${state.changed.sha.slice(0, 7)}. Synthetic draft restored.`,
);
