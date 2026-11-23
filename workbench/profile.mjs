const presetDocuments = [
  {
    "id": "TASK_EXECUTION_STANDARD.md",
    "name": "Task execution standard",
    "filename": "TASK_EXECUTION_STANDARD.md",
    "source": "Adapted engine",
    "content": "# Task execution standard\n\nEvery agent must use this standard for every coding task in a project that uses this harness. It applies to fresh projects, existing projects, reviewers, and repair agents. Read this standard and the applicable project rules before changing code.\n\n## ACTION\n\nState the exact change, the affected components, and the expected result. Review the relevant code and its callers. Record the action in the existing plan or task notes before editing.\n\n## CONSTRAINTS\n\nPreserve behavior unless the task explicitly changes it. Follow the project's conventions and architecture. Keep the change focused. Avoid unnecessary dependencies, abstractions, and files. Get approval before fixing an unrelated problem. Report conflicts with established rules and preserve those rules until the conflict is resolved.\n\n## VERIFICATION\n\nCheck current behavior before editing. Run the relevant tests before and after the change. If the application or test does not yet exist, record why a baseline cannot run. Run the test when the relevant behavior becomes available. Add or update a test when necessary. Verify the requested result and applicable regressions. Run relevant lint and static checks. Measure comparable before-and-after workloads when performance matters. Record the commands and their actual results. Name every required check that could not run and give the reason. Treat failed or missing required verification as incomplete work.\n\n## REPORTING\n\nUse these headings in the final report, in this order. Reuse the existing build log or review report for longer evidence. A short task can keep its record in the task conversation.\n\n- **ACTION** Describe the problem, the change, and the result.\n- **CONSTRAINTS** State what the change preserves and explain material decisions.\n- **VERIFICATION** Give the tests, results, and comparable measurements where relevant. State which checks failed or could not run.\n- **REPORTING** List changed files, remaining problems, risks, and limitations.\n\n## Writing\n\nApply ASD-STE100 principles to instructions, task specifications, documentation, README files, development plans, comments, test descriptions, reports, and AI-generated explanations. Use short, clear sentences and prefer active voice. Use precise words and consistent terms. Give one main action per instruction. Use complete sentences when they improve clarity. Remove ambiguous, redundant, or unnecessary wording. Preserve technical detail and accuracy.\n\nApply the wording rules to prose, comments, and natural-language test descriptions. Keep programming identifiers under normal Ruby, Rails, React, JavaScript, and TypeScript conventions. Claim formal ASD-STE100 compliance only after a separate compliance check.\n\n## Code quality\n\nPrioritize correctness, readability, simplicity, and maintainability in that order. Address performance when it matters. Apply all existing required safety and performance checks. Use descriptive names, direct control flow, and focused functions. Follow framework conventions. Remove duplication when it makes the rule easier to understand or change. Avoid speculative abstractions and premature optimization. Explain the reason for a decision in a comment when the code cannot show it clearly. Add a service, hook, helper, class, file, or dependency only when it has a clear purpose. Keep the diff easy to review.\n\n## Task examples\n\n| Task | Action and scope | Verification |\n|---|---|---|\n| Performance | Find the bottleneck and fix the confirmed cause. | Compare equivalent results and work before and after the change. |\n| Code quality | Audit for defects and maintenance problems. Fix confirmed issues in scope. | Verify the fix and preserved behavior. |\n| Refactoring | Improve readability where necessary. Preserve public behavior. | Run relevant regression tests before and after the change. |\n| Security | Verify the vulnerability. Fix the cause while preserving valid behavior where possible. | Run focused security and regression checks. |\n| Feature development | Review the requirements and affected code. Implement the smallest complete feature. | Test the expected behavior and relevant existing behavior. |\n| Bug fix | Reproduce the defect. Identify the cause and make a focused fix. | Reproduce the original failure and verify the fix. Keep a regression test when practical. |\n\nUse all four elements for each example. Report findings, changes, and evidence.\n\n## Completion gate\n\nReview the diff and the evidence before marking a task complete.\n\n- [ ] The requested action is complete.\n- [ ] The implementation follows project conventions.\n- [ ] The diff stays within the necessary scope.\n- [ ] The change preserves required behavior.\n- [ ] The relevant tests ran.\n- [ ] The report gives the test results.\n- [ ] The report gives the required measurements.\n- [ ] Each new dependency has a clear reason.\n- [ ] A developer can read and maintain the change.\n- [ ] The report gives the remaining risks.\n\nA failed or incomplete required check prevents a completion claim. Report the failure and its effect. Never invent evidence. Use checks that apply to the task. The review gate supplements the project's existing test, safety, performance, and review gates.\n"
  },
  {
    "id": "STANDARDS.md",
    "name": "Engineering standards",
    "filename": "STANDARDS.md",
    "source": "Adapted engine",
    "content": "# Engineering standards\n\nPrioritize correctness, readability, simplicity, maintainability, and applicable performance. Follow project and framework conventions. Use descriptive names and direct control flow. Keep each rule close to the writes or result it controls.\n\nRead the entry point first. Make the main sequence, transaction owner, expected failure, and caller result easy to find. Extract a private step when its name reduces reading effort. Do not use quotas for classes, services, methods, or lines.\n\nKeep HTTP inputs and responses in controllers. Keep screen-specific queries and response assembly in named private controller methods when they improve comprehension. Models own persistence and record rules. A separate workflow object needs shared callers or a business and transaction boundary that warrants its own owner and tests. Do not add a wrapper only to move code.\n\nUse plain Active Record for application queries. Rails-generated SQL is normal. Keep SQL strings, SQL expressions, Arel, and authored query views or functions out of application query logic where Active Record expresses the rule. Check the real data source behind relations. Do not trade this readability requirement for a faster SQL string.\n\nQuery for the result the caller needs. Use scoped existence checks, scalar projections, database aggregation, bounded lists, and required association loading. Check repeated work across the complete operation. A lower query count alone does not establish better performance.\n\nMake transaction boundaries visible. Identify expected failures where their cause is known. Preserve unexpected causes. Use a savepoint only when an inner failure has a defined recovery path. Persist required failure state outside the rollback it must survive. Do not hide defects with broad rescue or invented fallback values.\n\nUse constraints and indexes when integrity requires them. Check concurrency and retry behavior where effects can repeat. Bulk APIs need evidence that callbacks, validation, timestamps, uniqueness, and rollback still satisfy the contract.\n\nUse framework naming and loading conventions. Keep components, hooks, services, classes, and dependencies only when their responsibility is clear. Avoid speculative abstractions, duplicate rule owners, unnecessary state, and unrelated cleanup.\n\nFor React, prefer explicit props, local state, semantic HTML, and clear loading, error, empty, and success states. Use effects to synchronize with external systems. Do not store values that can be derived directly. Add shared state or dependencies only for a demonstrated need.\n\nWrite tests for observable behavior and meaningful failure paths. Avoid assertions that only mirror internal implementation. Write comments that explain the reason. Keep private details private. Follow established bang-method conventions instead of adding exclamation marks to ordinary custom methods.\n"
  },
  {
    "id": "REVIEW.md",
    "name": "Review rubric",
    "filename": "REVIEW.md",
    "source": "Adapted engine",
    "content": "# Review and repair\n\nRecord a source checkpoint before grading. Review the actual implementation through its normal callers. Confirm findings against current source. Distinguish defects, risks, preferences, and missing evidence.\n\nUse pass only when the current criterion has relevant evidence. Use revise for a confirmed material issue. Use unverified when required evidence is missing. Name a genuine prerequisite when blocked. Missing or failed required verification prevents completion.\n\nReview these criteria:\n\n1. Correctness. Check the accepted result, neighboring behavior, identities, and side effects.\n2. Human readability. Trace the entry point, main sequence, rule owners, writes, failures, and result.\n3. Maintainability. Identify a plausible rule change and its owner. Use a disposable change exercise when it materially tests the claim.\n4. Performance. Measure complete operations and growth where applicable. Preserve plain Active Record.\n5. Failure handling. Check what persists, rolls back, retries, and reaches the caller.\n6. Scope and constraints. Preserve accepted decisions, unrelated work, fixed external contracts, and permission boundaries.\n\nFor each claim, state a concrete failure and the evidence that addresses it. Relevant assertions matter more than test names or green summaries. Mark not applicable only with a concrete reason and evidence.\n\nUse separate review when available. Label dedicated self-review accurately. Neither a synthetic review fixture nor structural JSON validation proves code quality. The agent owns the grade and repairs. The user does not need to validate the grade by reading code.\n\nRecord a repair round before changes. Fix the smallest responsible area. Run affected checks. Regrade the current source. Carry forward evidence only when its source and inputs still apply. Run final configured gates before task finish.\n\nStop when all required current gates pass. Stop and report when the configured repair limit is reached or a prerequisite is genuinely unavailable. Do not widen scope or weaken checks to obtain a pass. Keep failed attempts and remaining issues visible.\n"
  },
  {
    "id": "PERFORMANCE.md",
    "name": "Performance evidence",
    "filename": "PERFORMANCE.md",
    "source": "Adapted engine",
    "content": "# Performance evidence\n\nTrace material operations from the actual caller through source reads, local writes, serialization, and external calls. Choose work by frequency, consequence, and expected growth. Keep the plain Active Record standard.\n\nBefore implementation, identify the required rows and smallest useful result. Filter, order, bound, and aggregate before materialization where the rule permits it. Reuse already loaded values within the required consistency boundary. Check association queries during serialization and repeated reads or writes in loops.\n\nCreate a project benchmark from accepted requirements. Record caller, starting state, fixture construction, workload, expected identities and effects, metrics, repetitions, and reset procedure. Freeze the contract, scripts, and relevant fixed inputs before baseline measurement.\n\nMeasure the complete operation. Separate database bootstrap from first population. Include source transfer, mirror import, derived-value creation and maintenance, applicable locks, writes, and retries. Do not prepare derived application fields outside timing when production must maintain them.\n\nMeasure added unrelated data with a fixed result separately from added required work with a larger expected result. Check first population and unchanged repeats. Confirm exact responses, identities, ordering, permissions, and persisted effects before interpreting cost.\n\nRecord applicable statements, returned rows, model objects, affected rows, source bytes, response bytes, external calls, elapsed time, and memory. State unavailable telemetry. A scalar result can hide a large scan. Read-only diagnostic plans can explain database work without introducing SQL strings into application query logic.\n\nInspect real query sources. A source checker only proves the patterns it recognizes. Require the project's configured query-source gate when applicable. Do not claim that an instruction hash ran that gate.\n\nFix confirmed unnecessary work at its responsible owner. Verify correctness and cost together. Report necessary growth and tradeoffs. Never accept an optimization only because it reduces one counter. Keep external final evaluation outside builder inputs and the internal repair loop.\n"
  }
];

"use strict";
const modelCatalog = {
  "captured": "2026-11-21",
  "Muse": {
    "source": "muse exec --list-models",
    "models": [
      "muse-wonder-1.0",
      "muse-ember-1.0",
      "muse-spark-1.3",
      "muse-spark-1.2"
    ]
  },
  "Codex": {
    "source": "Installed Codex model catalog, visible entries",
    "models": [
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "gpt-6.1-terra",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna"
    ]
  }
};

"use strict";

const WorkbenchProfile = (() => {
  const roles = [
    {id: "plan", name: "Plan", icon: "≡", kind: "Agent", description: "Define scope, acceptance criteria, and unresolved questions."},
    {id: "planReview", name: "Plan audit", icon: "◇", kind: "Audit", description: "Review the plan against the request before implementation."},
    {id: "build", name: "Build & repair", icon: "⌘", kind: "Agent", description: "Implement the reviewed plan or fix a recorded finding."},
    {id: "checks", name: "Project checks", icon: "✓", kind: "Gate", description: "Run behavior checks and benchmarks on the current source."},
    {id: "buildReview", name: "Build audit", icon: "◇", kind: "Audit", description: "Review the implementation and its check receipts."},
    {id: "finalReview", name: "Final audit", icon: "◇", kind: "Audit", description: "Start a fresh review and record evidence for each criterion."},
    {id: "verify", name: "Verify & report", icon: "▤", kind: "Gate", description: "Verify the evidence against the current source and report."}
  ];
  const audits = roles.filter(role => role.kind === "Audit");
  const efforts = ["low", "medium", "high", "xhigh"];
  const providers = ["Codex", "Muse", "RubyMine Air", "Human", "Custom"];
  const providerBounds = {
    timeoutSeconds: [10, 1800],
    providerTimeSeconds: [60, 7200],
    providerTokenLimit: [1000, 2_000_000]
  };
  const decisions = {
    planReview: ["plan", "stop"],
    buildReview: ["build", "plan", "stop"],
    finalReview: ["build", "plan", "stop"]
  };
  const preset = {
    plan: ["Define acceptance criteria and ask one unresolved business question at a time.", ["TASK_EXECUTION_STANDARD.md"]],
    planReview: ["Check the plan against the original request. Return a verdict with evidence.", ["REVIEW.md"]],
    build: ["Implement the approved plan within scope. Record repairs and leave task receipts to Workbench.", ["TASK_EXECUTION_STANDARD.md", "STANDARDS.md", "PERFORMANCE.md"]],
    checks: ["Run applicable checks and benchmarks. A failed check blocks a passing build audit.", []],
    buildReview: ["Inspect the current source and check receipts. Send confirmed code findings to the builder.", ["REVIEW.md"]],
    finalReview: ["Use a fresh review session. Verify all rubric criteria against the checked source.", ["REVIEW.md"]],
    verify: ["Confirm the checked and reviewed source fingerprints match. Record the result.", []]
  };

  function profile(mode, docs) {
    const fast = mode === "fast";
    return {
      name: fast ? "Fast build" : "Audited build",
      rules: "Keep changes within the agreed scope. Require current evidence before completion. Keep independent evaluation inputs outside the builder context.",
      sharedDocs: [],
      stages: Object.fromEntries(roles.map(({id, kind}) => [id, {
        enabled: !(fast && id === "finalReview"),
        provider: kind === "Gate" ? "Workbench" : kind === "Audit" ? "Muse" : "Codex",
        model: kind === "Agent" ? "gpt-6.2-astra" : "",
        effort: fast ? "medium" : "high",
        instructions: preset[id][0],
        docs: preset[id][1].filter(docId => docs.some(doc => doc.id === docId)),
        limit: fast ? 1 : 3,
        route: id === "planReview" ? "plan" : "build",
        requirementsRoute: "plan"
      }]))
    };
  }

  function initial(documents) {
    return {version: 1, active: "audited", documents, profiles: {
      audited: profile("audited", documents), fast: profile("fast", documents)
    }};
  }

  function validate(data) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const string = (value, max) => typeof value === "string" && value.length <= max;
    const validLimit = (value, key) => value === undefined ||
      Number.isSafeInteger(value) && value >= providerBounds[key][0] && value <= providerBounds[key][1];
    assert(data?.version === 1 && ["audited", "fast"].includes(data.active), "Use a version 1 profile export.");
    assert(Array.isArray(data.documents) && data.documents.length <= 60, "The document library supports up to 60 files.");
    const ids = new Set();
    for (const doc of data.documents) {
      assert(doc && string(doc.id, 150) && doc.id && !ids.has(doc.id) && string(doc.name, 120)
        && string(doc.filename, 150) && string(doc.source, 80) && string(doc.content, 350000), "A document has invalid fields.");
      ids.add(doc.id);
    }
    function validDocs(list) {
      return Array.isArray(list) && new Set(list).size === list.length && list.every(id => ids.has(id));
    }
    for (const mode of ["audited", "fast"]) {
      const item = data.profiles?.[mode];
      assert(item && string(item.name, 80) && item.name.trim() && string(item.rules, 20000) && validDocs(item.sharedDocs), "A profile has invalid shared rules or documents.");
      assert(validLimit(item.providerTimeSeconds, "providerTimeSeconds") && validLimit(item.providerTokenLimit, "providerTokenLimit"),
        "Set a task provider time limit from 60 to 7200 seconds and a token limit from 1000 to 2000000.");
      for (const {id, kind} of roles) {
        const stage = item.stages?.[id];
        assert(stage && typeof stage.enabled === "boolean" && string(stage.instructions, 20000) && validDocs(stage.docs)
          && string(stage.model, 120) && efforts.includes(stage.effort), "A stage has invalid instructions or settings.");
        assert(kind === "Gate" ? stage.provider === "Workbench" : providers.includes(stage.provider), "A stage has an invalid provider.");
        assert(validLimit(stage.timeoutSeconds, "timeoutSeconds"), "Set a provider call time limit from 10 to 1800 seconds.");
        assert(stage.shellTools === undefined || typeof stage.shellTools === "boolean", "Set shell access to on or off.");
        const hints = stage.toolHints ?? [];
        assert(Array.isArray(hints) && hints.length <= 32 && new Set(hints).size === hints.length &&
          hints.every(name => typeof name === "string" && /^[a-z][a-z0-9_]{0,67}$/.test(name)), "Select valid stage tools.");
        assert(kind === "Audit" || stage.enabled, "Planning, building, and verification stages are required.");
        if (kind === "Audit") {
          assert(decisions[id].includes(stage.route) && Number.isInteger(stage.limit) && stage.limit >= 1 && stage.limit <= 20, "An audit has an invalid return route or limit.");
          assert(["plan", "stop"].includes(stage.requirementsRoute), "A requirements finding has an invalid return route.");
        }
      }
    }
    assert(JSON.stringify(data).length <= 1850000, "The profile exceeds local storage capacity. Remove a document and retry.");
    return data;
  }

  function stageProviders(id, catalog) {
    const eligible = id === "build" ? ["Codex"] : ["Codex", "Muse"];
    return eligible.filter(provider => Object.hasOwn(catalog, provider));
  }

  function providerLimits(item, mode, stage) {
    const fast = mode === "fast";
    return {
      timeoutSeconds: item.stages?.[stage]?.timeoutSeconds ?? (stage === "build" ? 300 : 120),
      providerTimeSeconds: item.providerTimeSeconds ?? (fast ? 600 : 1800),
      providerTokenLimit: item.providerTokenLimit ?? (fast ? 60_000 : 180_000)
    };
  }

  function executable(data, catalog) {
    validate(data);
    const keys = ["version", "active", "profiles", "documents", "permittedTools", "checks", "benchmark"];
    if (Object.keys(data).some(key => !keys.includes(key)) || Object.keys(data.profiles).length !== 2) {
      throw Error("Unknown profile fields.");
    }
    for (const [mode, profile] of Object.entries(data.profiles)) {
      for (const {id, kind} of roles) {
        const stage = profile.stages[id];
        if (!stage.enabled && !(mode === "fast" && id === "finalReview")) {
          throw Error(mode + " requires " + id + ".");
        }
        if (kind === "Gate" || !stage.enabled) continue;
        if (!stageProviders(id, catalog).includes(stage.provider)) {
          throw Error("Unsupported provider for " + id + ": " + stage.provider);
        }
        if (stage.model && !catalog[stage.provider].models.includes(stage.model)) {
          throw Error("Unsupported model for " + stage.provider + ": " + stage.model);
        }
      }
    }
    const names = data.permittedTools ?? [];
    if (!Array.isArray(names) || names.length > 32 || new Set(names).size !== names.length ||
        names.some(name => typeof name !== "string" || !/^app_[a-z][a-z0-9_]{0,63}$/.test(name))) {
      throw Error("Use unique app_ tool names.");
    }
    return {...data, permittedTools: names};
  }

  function sameValue(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object" ||
        Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }

  function resolve(candidate, settings, documents, catalog) {
    const data = executable(candidate == null || candidate === false ? initial(documents) : candidate, catalog);
    const {checks: supplied = [], benchmark} = data;
    const {checks: inherited, benchmark: inheritedBenchmark = {}} = settings;
    if (!Array.isArray(supplied)) throw Error("Checks must be an array");
    if (!Array.isArray(inherited)) throw Error("Project checks must be an array");
    for (const check of inherited) {
      const other = supplied.find(row => row.name === check.name);
      if (other && !sameValue(other, check)) {
        throw Error("Change the inherited check in Project setup: " + check.name);
      }
    }
    if (inherited.some(check => check.benchmark) && Object.hasOwn(data, "benchmark") &&
        !sameValue(benchmark, settings.benchmark ?? null)) {
      throw Error("Change the inherited benchmark in Project setup");
    }
    const checks = inherited.concat(supplied.filter(row => !inherited.some(check => check.name === row.name)));
    return {...data, checks, benchmark: benchmark == null || benchmark === false ? inheritedBenchmark : benchmark};
  }

  function simulate(item, scenario) {
    const counts = {};
    const findingCounts = {};
    let repairs = 0;
    let index = 0;
    let baseline = false;
    const rows = [];
    while (index < roles.length) {
      const {id, name} = roles[index];
      const stage = item.stages[id];
      if (!stage.enabled) {
        index++;
        continue;
      }
      if (id === "build" && !baseline) {
        rows.push("Run applicable baseline checks");
        baseline = true;
      }
      const budget = id === "verify" ? "finalReview" : id === "checks" ? "buildReview" : id;
      const count = counts[budget] ?? 0;
      if ((findingCounts[id] ?? 0) >= (scenario[id] ?? 0)) {
        rows.push(name + " · pass");
        index++;
        continue;
      }
      const route = id === "checks" || id === "verify" ? "build" : scenario.requirements ? stage.requirementsRoute : stage.route;
      if (route === "stop" || count >= item.stages[budget].limit || (route === "build" && repairs >= item.stages.buildReview.limit)) {
        rows.push(name + " · stop and report the unresolved finding");
        return rows;
      }
      counts[budget] = count + 1;
      findingCounts[id] = (findingCounts[id] ?? 0) + 1;
      if (route === "build") repairs++;
      rows.push(name + " · return to " + roles.find(role => role.id === route).name);
      index = roles.findIndex(role => role.id === route);
    }
    return rows;
  }

  function stagePrompt(item, id, docs, permittedTools = [], stageTools) {
    const role = roles.find(role => role.id === id);
    const stage = item.stages[id];
    const text = ["# " + role.name, item.rules, stage.instructions];
    const tools = stageTools ?? (stage.toolHints || []).filter(name => !name.startsWith("app_") || permittedTools.includes(name));
    if (tools.length) text.push("Workbench MCP tools: " + tools.join(", "));
    for (const docId of new Set([...item.sharedDocs, ...stage.docs])) {
      const doc = docs.find(entry => entry.id === docId);
      text.push("## " + doc.filename + "\n\n" + doc.content);
    }
    return text.filter(Boolean).join("\n\n");
  }

  function nativeSettings(item) {
    const builder = item.stages.build;
    const settings = {execution: {max_repair_rounds: item.stages.buildReview.limit}};
    if (builder.provider === "Codex" && builder.model.trim()) {
      settings.agent = {model: builder.model.trim(), effort: builder.effort};
    }
    return settings;
  }

  return {roles, audits, efforts, providers, decisions, initial, validate, executable, resolve, simulate, stagePrompt,
    nativeSettings, stageProviders, providerLimits, providerBounds};
})();

export {WorkbenchProfile, modelCatalog, presetDocuments};
