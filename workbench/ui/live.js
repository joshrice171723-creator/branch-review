"use strict";

function planningAnswer(question, suggestions, send) {
  if (!Array.isArray(suggestions) || suggestions.length < 2) return element("p", "", "Suggested answers unavailable.");
  const input = element("textarea");
  const choices = element("div", "answer-choices");
  for (const text of suggestions) choices.append(button(text, () => { input.value = text; input.focus(); }));
  const submit = button("Submit answer and resume", async () => {
    if (!input.value.trim() || submit.disabled) return;
    submit.disabled = true;
    try { await send(input.value); } finally { submit.disabled = false; }
  }, "button primary");
  return element("div", "decision", field(question, input), choices, submit);
}

function livePanel() {
  const panel = element("section", "panel");
  const controls = element("div", "panel-body");
  const results = element("ol", "timeline");
  const status = element("p", "history-status");
  status.setAttribute("role", "status");
  panel.append(heading("Task activity"), controls, status, results);
  let taskId, cursor = 0, formKey, jobId;
  async function submit(fn) {
    try { await fn(); formKey = null; }
    catch (error) { status.textContent = error.message; }
  }
  function createTask() {
    const action = element("textarea");
    const scope = element("textarea");
    const mode = select("build", ["build", "feature", "refactor", "audit"].map(x => [x, x]), () => true);
    const create = button("Create task", () => submit(async () => {
      if (byId("apply-profile").textContent === "Apply changes") throw Error("Apply profile changes in Configure → Stage designer.");
      if (!stateProfileApplied()) throw Error("Apply a profile before creating a panel run.");
      const saved = await api("task", {mode: mode.value, action: action.value, scope: scope.value});
      status.textContent = "Created " + saved.created.data.task_id;
    }), "button primary");
    return element("div", "", field("Mode", mode), field("Action", action), field("Scope", scope), create);
  }
  function taskForm(state, task, running) {
    if (!task) return createTask();
    if (["completed", "stopped"].includes(task.status)) {
      return element("div", "", element("h3", "", task.status === "completed" ? "Run completed" : "Run stopped"),
        element("p", "", task.action), element("p", "", task.lifecycle?.reason || ""),
        element("h3", "", "Start another task"), createTask());
    }
    const title = element("h3", "", task.action);
    const form = element("div", "", title, element("code", "", task.id));
    const question = state.questions.find(q => q.required && !task.answers[q.id]);
    if (task.status === "paused") {
      form.append(button("Resume task", () => submit(() => api("task/action", {action: "resume", id: task.id}))));
    } else if (question) {
      const choice = select("", [["", "Select an answer"], ...question.options.map(v => [v, v])], () => true);
      form.append(field(question.text, choice), button("Record answer", () => submit(() =>
        api("answer", {question: question.id, option: choice.value}))));
    } else if (running) {
      form.append(button("Cancel run", () => submit(() => api("chat/cancel", {id: running.id}))));
    } else if (state.coordinator_running) {
      form.append(element("p", "", "A coordinator is already running this task."));
    } else {
      const resume = message => submit(async () => {
        const reply = await api("chat", task.question ? {message, question: task.question,
          question_id: task.question_id, task: task.id} : {message});
        jobId = reply.id;
        status.textContent = reply.response || "Run started.";
      });
      if (task.question) form.append(planningAnswer(task.question, task.suggestions, resume));
      else {
        if (task.question_error) form.append(element("p", "evidence-warning", task.question_error));
        form.append(button(task.question_error ? "Retry suggestions" : "Run task", () => resume("/run"), "button primary"));
      }
    }
    return form;
  }
  async function refresh() {
    if (!panel.isConnected) return;
    try {
      const state = await api("live");
      if (!panel.isConnected) return;
      const task = state.active_task;
      const running = state.jobs.find(j => j.task_id === task?.id && ["starting", "running", "cancelling"].includes(j.state));
      const key = JSON.stringify([task?.id, task?.status, task?.question, task?.question_id, task?.suggestions, task?.question_error,
        task?.answers, running?.id, state.coordinator_running, state.design_question, state.design_retry, state.design_revision]);
      if (key !== formKey) {
        controls.replaceChildren(taskForm(state, task, running));
        const q = state.design_question;
        if (state.design_retry) controls.prepend(element("section", "decision",
          element("p", "evidence-warning", state.design_retry.error),
          button("Retry planning", () => submit(() => api("design/retry", {revision:state.design_revision})))));
        else if (q) controls.prepend(q.error ? button("Retry project suggestions", () => submit(() =>
          api("design/retry", {revision: state.design_revision}))) : planningAnswer(q.question, q.suggestions, message =>
          submit(() => api("design/answer", {revision: state.design_revision, id: q.id, message}))));
        formKey = key;
      }
      const job = state.jobs.find(j => j.id === jobId);
      if (job?.error) status.textContent = job.error;
      if (task) {
        if (taskId !== task.id) { taskId = task.id; cursor = 0; results.replaceChildren(); }
        const page = await api("events?id=" + encodeURIComponent(taskId) + "&after=" + cursor);
        if (!panel.isConnected) return;
        for (const e of page.events) results.append(element("li", "", element("strong", "", e.activity),
          element("small", "", [stageName(e.stage), e.actor, new Date(e.timestamp).toLocaleTimeString()].join(" · "))));
        cursor = page.cursor;
      }
    } catch (error) { status.textContent = error.message; }
    if (panel.isConnected) historyTimer = setTimeout(refresh, 900);
  }
  queueMicrotask(refresh);
  return panel;
}
