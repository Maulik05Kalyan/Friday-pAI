
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const WORKFLOWS_DIR = path.join(__dirname, "..", "..", "workflows");

const STATES = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  WAITING: "waiting_for_approval",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped",
});

function now() {
  return new Date().toISOString();
}

function loadWorkflow(workflowId) {
  if (
    typeof workflowId !== "string" ||
    !/^[a-z0-9-]+$/.test(workflowId)
  ) {
    throw new Error("Invalid workflow ID.");
  }

  const file = path.join(WORKFLOWS_DIR, `${workflowId}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  const workflow = JSON.parse(fs.readFileSync(file, "utf8"));
  validateWorkflow(workflow);

  if (workflow.id !== workflowId) {
    throw new Error("Workflow filename and ID do not match.");
  }

  return workflow;
}

function validateWorkflow(workflow) {
  if (
    !workflow ||
    typeof workflow.id !== "string" ||
    !Array.isArray(workflow.inputs) ||
    !Array.isArray(workflow.steps) ||
    !Array.isArray(workflow.allowedTools) ||
    workflow.steps.length === 0
  ) {
    throw new Error("Invalid workflow definition.");
  }

  const inputNames = new Set();

  for (const input of workflow.inputs) {
    if (!input || typeof input.name !== "string") {
      throw new Error("Invalid workflow input definition.");
    }
    if (inputNames.has(input.name)) {
      throw new Error(`Duplicate input: ${input.name}`);
    }
    inputNames.add(input.name);
  }

  const byId = new Map();

  for (const step of workflow.steps) {
    if (
      !step ||
      typeof step.id !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(step.id) ||
      typeof step.tool !== "string" ||
      !Array.isArray(step.dependsOn)
    ) {
      throw new Error("Invalid workflow step.");
    }

    if (byId.has(step.id)) {
      throw new Error(`Duplicate step ID: ${step.id}`);
    }

    if (!workflow.allowedTools.includes(step.tool)) {
      throw new Error(`Tool "${step.tool}" is not allowed.`);
    }

    if (
      step.approval !== undefined &&
      !["none", "required"].includes(step.approval)
    ) {
      throw new Error(`Invalid approval policy for "${step.id}".`);
    }

    byId.set(step.id, step);
  }

  const visited = new Set();
  const visiting = new Set();

  function visit(id) {
    if (visiting.has(id)) {
      throw new Error("Circular workflow dependencies detected.");
    }
    if (visited.has(id)) return;

    const step = byId.get(id);
    visiting.add(id);

    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(
          `Unknown dependency "${dependency}" in "${id}".`
        );
      }
      if (dependency === id) {
        throw new Error(`Step "${id}" cannot depend on itself.`);
      }
      visit(dependency);
    }

    visiting.delete(id);
    visited.add(id);
  }

  for (const id of byId.keys()) visit(id);
  return true;
}

function validateInputs(workflow, inputs = {}) {
  if (
    !inputs ||
    typeof inputs !== "object" ||
    Array.isArray(inputs)
  ) {
    throw new Error("Inputs must be an object.");
  }

  const definitions = new Map(
    workflow.inputs.map(input => [input.name, input])
  );

  for (const key of Object.keys(inputs)) {
    if (!definitions.has(key)) {
      throw new Error(`Unexpected input: ${key}`);
    }
  }

  for (const definition of workflow.inputs) {
    const value = inputs[definition.name];

    if (
      definition.required &&
      (value === undefined || value === null || value === "")
    ) {
      throw new Error(`Missing required input: ${definition.name}`);
    }

    if (value === undefined || value === null) continue;

    if (
      definition.type === "string" &&
      typeof value !== "string"
    ) {
      throw new Error(`${definition.name} must be a string.`);
    }

    if (
      definition.type === "array" &&
      !Array.isArray(value)
    ) {
      throw new Error(`${definition.name} must be an array.`);
    }

    if (
      definition.type === "number" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(`${definition.name} must be a number.`);
    }
  }

  return true;
}

function createWorkflowRun(workflow, inputs = {}, options = {}) {
  validateWorkflow(workflow);
  validateInputs(workflow, inputs);

  const timestamp = now();

  return {
    runId: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowVersion: workflow.version || "1.0.0",
    inputs: { ...inputs },
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
    steps: workflow.steps.map(definition => ({
      stepId: definition.id,
      tool: definition.tool,
      state: STATES.PENDING,
      attempts: 0,
      maxAttempts: Math.max(
        1,
        Math.min(options.maxAttempts || 2, 5)
      ),
      dependsOn: [...definition.dependsOn],
      approval: definition.approval || "none",
      capabilityStatus: definition.capabilityStatus || "available",
      result: null,
      error: null,
    })),
  };
}

function getReadySteps(workflow, run) {
  const states = new Map(
    run.steps.map(step => [step.stepId, step.state])
  );

  return workflow.steps
    .filter(definition => {
      const current = run.steps.find(
        step => step.stepId === definition.id
      );

      return (
        current &&
        current.state === STATES.PENDING &&
        current.capabilityStatus === "available" &&
        current.approval !== "required" &&
        definition.dependsOn.every(
          id => states.get(id) === STATES.SUCCEEDED
        )
      );
    })
    .map(step => step.id);
}

function updateRunStatus(run) {
  run.updatedAt = now();

  if (run.steps.some(s => s.state === STATES.FAILED)) {
    run.status = "failed";
  } else if (run.steps.some(s => s.state === STATES.WAITING)) {
    run.status = "waiting_for_approval";
  } else if (
    run.steps.every(
      s => s.state === STATES.SUCCEEDED || s.state === STATES.SKIPPED
    )
  ) {
    run.status = "completed";
  } else if (
    run.steps.some(s => s.state === STATES.RUNNING)
  ) {
    run.status = "in_progress";
  } else {
    run.status = "ready";
  }
}

function startStep(workflow, run, stepId) {
  const definition = workflow.steps.find(s => s.id === stepId);
  const step = run.steps.find(s => s.stepId === stepId);

  if (!definition || !step) throw new Error(`Step not found: ${stepId}`);
  if (step.state !== STATES.PENDING) {
    throw new Error(`Step "${stepId}" is not pending.`);
  }
  if (!workflow.allowedTools.includes(step.tool)) {
    throw new Error(`Tool "${step.tool}" is not allowed.`);
  }
  if (step.capabilityStatus !== "available") {
    throw new Error(`Capability not implemented: ${step.tool}`);
  }
  if (step.approval === "required") {
    throw new Error(`Step "${stepId}" requires approval.`);
  }

  for (const dependency of definition.dependsOn) {
    const previous = run.steps.find(s => s.stepId === dependency);
    if (!previous || previous.state !== STATES.SUCCEEDED) {
      throw new Error(`Dependency "${dependency}" has not succeeded.`);
    }
  }

  step.state = STATES.RUNNING;
  step.attempts += 1;
  step.error = null;
  updateRunStatus(run);
  return run;
}

function requestStepApproval(workflow, run, stepId) {
  const definition = workflow.steps.find(s => s.id === stepId);
  const step = run.steps.find(s => s.stepId === stepId);

  if (!definition || !step) throw new Error(`Step not found: ${stepId}`);
  if (step.state !== STATES.PENDING) {
    throw new Error("Only pending steps can request approval.");
  }
  if (step.approval !== "required") {
    throw new Error("This step does not require approval.");
  }
  if (step.capabilityStatus !== "available") {
    throw new Error(`Capability not implemented: ${step.tool}`);
  }

  for (const dependency of definition.dependsOn) {
    const previous = run.steps.find(s => s.stepId === dependency);
    if (!previous || previous.state !== STATES.SUCCEEDED) {
      throw new Error(`Dependency "${dependency}" has not succeeded.`);
    }
  }

  step.state = STATES.WAITING;
  updateRunStatus(run);
  return run;
}

function resolveApproval(workflow, run, stepId, approved) {
  const step = run.steps.find(s => s.stepId === stepId);

  if (!step || step.state !== STATES.WAITING) {
    throw new Error("No approval is pending for this step.");
  }

  if (approved !== true && approved !== false) {
    throw new Error("Approval decision must be true or false.");
  }

  if (approved) {
    // Approval allows execution; it does not claim success.
    step.state = STATES.PENDING;
    step.approval = "approved";
  } else {
    step.state = STATES.SKIPPED;
    step.error = "Approval declined by user.";
  }

  updateRunStatus(run);
  return run;
}

function recordStepResult(run, stepId, result) {
  const step = run.steps.find(s => s.stepId === stepId);

  if (!step || step.state !== STATES.RUNNING) {
    throw new Error("Step must be running before recording a result.");
  }

  step.state = STATES.SUCCEEDED;
  step.result = result === undefined ? null : result;
  step.error = null;
  updateRunStatus(run);
  return run;
}

function recordStepFailure(run, stepId, errorMessage) {
  const step = run.steps.find(s => s.stepId === stepId);

  if (!step || step.state !== STATES.RUNNING) {
    throw new Error("Step must be running before recording failure.");
  }

  step.error = String(errorMessage || "Unknown error");

  if (step.attempts < step.maxAttempts) {
    step.state = STATES.PENDING;
  } else {
    step.state = STATES.FAILED;
  }

  updateRunStatus(run);
  return run;
}

function recoverRun(run) {
  for (const step of run.steps) {
    // A process may have stopped after marking a step running.
    // Reset it for a bounded retry; external actions must be idempotent.
    if (step.state === STATES.RUNNING) {
      step.state =
        step.attempts < step.maxAttempts
          ? STATES.PENDING
          : STATES.FAILED;
      step.error = "Recovered after interruption.";
    }
  }

  updateRunStatus(run);
  return run;
}

async function executeWorkflow(workflow, run, options = {}) {
  const executeTool = options.executeTool;
  const persist = options.persist || (async () => {});
  const recordEvent = options.recordEvent || (async () => {});

  if (typeof executeTool !== "function") {
    throw new Error("executeTool callback is required.");
  }

  validateWorkflow(workflow);

  if (run.workflowId !== workflow.id) {
    throw new Error("Run and workflow IDs do not match.");
  }

  if (["completed", "failed", "cancelled"].includes(run.status)) {
    throw new Error(`Cannot execute a ${run.status} workflow.`);
  }

  const maxSteps = Math.min(
    Math.max(options.maxSteps || 50, 1),
    200
  );
  let processed = 0;

  await persist(run);

  while (processed < maxSteps) {
    const waiting = run.steps.find(s => s.state === STATES.WAITING);

    if (waiting) {
      run.status = "waiting_for_approval";
      await persist(run);
      return run;
    }

    const failedDependency = workflow.steps.find(definition => {
      const current = run.steps.find(s => s.stepId === definition.id);
      return (
        current.state === STATES.PENDING &&
        definition.dependsOn.some(id => {
          const dependency = run.steps.find(s => s.stepId === id);
          return dependency &&
            [STATES.FAILED, STATES.SKIPPED].includes(dependency.state);
        })
      );
    });

    if (failedDependency) {
      const blocked = run.steps.find(
        s => s.stepId === failedDependency.id
      );
      blocked.state = STATES.SKIPPED;
      blocked.error = "A dependency did not succeed.";
      await recordEvent({
        type: "step_skipped",
        workflowId: run.workflowId,
        runId: run.runId,
        stepId: blocked.stepId,
      });
      updateRunStatus(run);
      await persist(run);
      continue;
    }

    const approvalStep = workflow.steps.find(definition => {
      const current = run.steps.find(s => s.stepId === definition.id);
      return (
        current.state === STATES.PENDING &&
        current.approval === "required" &&
        current.capabilityStatus === "available" &&
        definition.dependsOn.every(id =>
          run.steps.some(
            s => s.stepId === id && s.state === STATES.SUCCEEDED
          )
        )
      );
    });

    if (approvalStep) {
      requestStepApproval(workflow, run, approvalStep.id);
      await recordEvent({
        type: "approval_requested",
        workflowId: run.workflowId,
        runId: run.runId,
        stepId: approvalStep.id,
      });
      await persist(run);
      return run;
    }

    const ready = getReadySteps(workflow, run);

    if (ready.length === 0) break;

    const stepId = ready[0];
    const definition = workflow.steps.find(s => s.id === stepId);
    const step = run.steps.find(s => s.stepId === stepId);

    startStep(workflow, run, stepId);
    await recordEvent({
      type: "step_started",
      workflowId: run.workflowId,
      runId: run.runId,
      stepId,
      tool: step.tool,
      attempt: step.attempts,
    });
    await persist(run);

    try {
      const result = await executeTool(step.tool, {
        workflowId: workflow.id,
        runId: run.runId,
        stepId,
        inputs: { ...run.inputs },
        previousResults: Object.fromEntries(
          run.steps
            .filter(s => s.state === STATES.SUCCEEDED)
            .map(s => [s.stepId, s.result])
        ),
      });

      if (!result || result.success !== true) {
        throw new Error(
          result && result.error
            ? result.error
            : `Tool "${step.tool}" did not report success.`
        );
      }

      recordStepResult(run, stepId, result.data ?? result);
      await recordEvent({
        type: "step_succeeded",
        workflowId: run.workflowId,
        runId: run.runId,
        stepId,
      });
    } catch (error) {
      recordStepFailure(run, stepId, error.message);
      await recordEvent({
        type: "step_failed",
        workflowId: run.workflowId,
        runId: run.runId,
        stepId,
        error: step.error,
        retrying: step.state === STATES.PENDING,
      });
    }

    await persist(run);
    processed += 1;

    if (step.state === STATES.FAILED) {
      // Do not keep running unrelated steps after a terminal failure.
      break;
    }
  }

  updateRunStatus(run);

  if (
    processed >= maxSteps &&
    run.status !== "completed" &&
    run.status !== "failed"
  ) {
    run.status = "paused";
  }

  await persist(run);
  return run;
}

async function resumeWorkflow(workflow, run, options = {}) {
  if (run.status === "failed") {
    const retryable = run.steps.filter(
      step =>
        step.state === STATES.FAILED &&
        step.attempts < step.maxAttempts
    );

    for (const step of retryable) {
      step.state = STATES.PENDING;
      step.error = null;
    }
  }

  if (run.status === "paused") {
    run.status = "ready";
  }

  return executeWorkflow(workflow, run, options);
}

module.exports = {
  STATES,
  loadWorkflow,
  validateWorkflow,
  validateInputs,
  createWorkflowRun,
  getReadySteps,
  startStep,
  requestStepApproval,
  resolveApproval,
  recordStepResult,
  recordStepFailure,
  recoverRun,
  executeWorkflow,
  resumeWorkflow,
};


