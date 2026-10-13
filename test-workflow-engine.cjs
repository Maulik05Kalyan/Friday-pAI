
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const engine = require("./electron/agent/workflowEngine.cjs");
const recorder = require("./electron/agent/taskRecorder.cjs");

const DATA_DIR = path.join(__dirname, "data");
const RUNS_FILE = path.join(DATA_DIR, "workflow-runs.json");
const EVENTS_FILE = path.join(DATA_DIR, "task-events.json");

let passed = 0;

function test(name, callback) {
  try {
    callback();
    console.log(`PASS ${++passed}: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

async function asyncTest(name, callback) {
  try {
    await callback();
    console.log(`PASS ${++passed}: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

async function main() {
  // Keep test persistence isolated from any existing data.
  const originalDataDir = DATA_DIR;

  // Reset only the two test files used by this suite.
  fs.mkdirSync(originalDataDir, { recursive: true });

  for (const file of [RUNS_FILE, EVENTS_FILE]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  const workflow = engine.loadWorkflow("research-study");

  test("Loads the research workflow", () => {
    assert.equal(workflow.id, "research-study");
    assert.equal(engine.validateWorkflow(workflow), true);
  });

  test("Rejects missing required inputs", () => {
    assert.throws(
      () => engine.createWorkflowRun(workflow, {}),
      /Missing required input/
    );
  });

  test("Rejects unknown input names", () => {
    assert.throws(
      () => engine.createWorkflowRun(workflow, {
        topic: "AI",
        unexpected: true,
      }),
      /Unexpected input/
    );
  });

  const run = engine.createWorkflowRun(workflow, {
    topic: "Artificial intelligence",
    focus: "Personal assistants",
  });

  test("Creates a run with pending steps", () => {
    assert.equal(run.status, "ready");
    assert.ok(run.runId);
    assert.ok(run.steps.every(s => s.state === "pending"));
  });

  test("Only the first dependent step is ready", () => {
    assert.deepEqual(engine.getReadySteps(workflow, run), ["search"]);
  });

  test("Cannot start a step before dependencies succeed", () => {
    assert.throws(
      () => engine.startStep(workflow, run, "summarize"),
      /Dependency/
    );
  });

  test("Starts the first step", () => {
    engine.startStep(workflow, run, "search");
    assert.equal(
      run.steps.find(s => s.stepId === "search").state,
      "running"
    );
  });

  test("Records successful step results", () => {
    engine.recordStepResult(run, "search", { test: true });
    assert.equal(
      run.steps.find(s => s.stepId === "search").state,
      "succeeded"
    );
  });

  test("Unlocks the next dependent step", () => {
    assert.deepEqual(engine.getReadySteps(workflow, run), ["summarize"]);
  });

  test("Rejects unimplemented capabilities", () => {
    assert.throws(
      () => engine.startStep(workflow, run, "save_notes"),
      /Capability not implemented/
    );
  });

  test("Retries a failed step within its limit", () => {
    const retryRun = engine.createWorkflowRun(workflow, {
      topic: "Testing",
    });

    engine.startStep(workflow, retryRun, "search");
    engine.recordStepFailure(retryRun, "search", "Temporary error");

    const search = retryRun.steps.find(s => s.stepId === "search");
    assert.equal(search.state, "pending");
    assert.equal(search.attempts, 1);
  });

  test("Stops retrying after the attempt limit", () => {
    const retryRun = engine.createWorkflowRun(workflow, {
      topic: "Testing",
    });
    const search = retryRun.steps.find(s => s.stepId === "search");
    search.maxAttempts = 1;

    engine.startStep(workflow, retryRun, "search");
    engine.recordStepFailure(retryRun, "search", "Permanent error");

    assert.equal(search.state, "failed");
  });

  test("Requires approval before a protected step", () => {
    const approvalWorkflow = {
      id: "approval-test",
      version: "1.0.0",
      inputs: [],
      allowedTools: ["safe_test_tool"],
      steps: [{
        id: "protected",
        tool: "safe_test_tool",
        dependsOn: [],
        approval: "required",
      }],
    };

    const approvalRun = engine.createWorkflowRun(approvalWorkflow);

    assert.deepEqual(engine.getReadySteps(approvalWorkflow, approvalRun), []);

    engine.requestStepApproval(approvalWorkflow, approvalRun, "protected");
    assert.equal(
      approvalRun.steps[0].state,
      "waiting_for_approval"
    );

    engine.resolveApproval(
      approvalWorkflow,
      approvalRun,
      "protected",
      true
    );

    assert.equal(approvalRun.steps[0].state, "pending");
    assert.equal(approvalRun.steps[0].approval, "approved");
  });

  test("Declined approval skips the protected step", () => {
    const approvalWorkflow = {
      id: "approval-decline-test",
      inputs: [],
      allowedTools: ["safe_test_tool"],
      steps: [{
        id: "protected",
        tool: "safe_test_tool",
        dependsOn: [],
        approval: "required",
      }],
    };

    const approvalRun = engine.createWorkflowRun(approvalWorkflow);
    engine.requestStepApproval(approvalWorkflow, approvalRun, "protected");
    engine.resolveApproval(
      approvalWorkflow,
      approvalRun,
      "protected",
      false
    );

    assert.equal(approvalRun.steps[0].state, "skipped");
  });

  test("Recovers interrupted running steps", () => {
    const recoveryRun = engine.createWorkflowRun(workflow, {
      topic: "Recovery",
    });

    engine.startStep(workflow, recoveryRun, "search");
    engine.recoverRun(recoveryRun);

    assert.equal(
      recoveryRun.steps.find(s => s.stepId === "search").state,
      "pending"
    );
  });

  test("Persists and reloads workflow runs", () => {
    recorder.saveRun(run);
    const loaded = recorder.getRun(run.runId);

    assert.ok(loaded);
    assert.equal(loaded.workflowId, "research-study");
    assert.equal(loaded.runId, run.runId);
  });

  test("Records compact task events", () => {
    recorder.recordEvent({
      type: "test_event",
      workflowId: workflow.id,
      runId: run.runId,
      stepId: "search",
      secret: "must not be stored",
    });

    const events = recorder.listEvents(run.runId);
    const event = events.find(e => e.type === "test_event");

    assert.ok(event);
    assert.equal(Object.hasOwn(event, "secret"), false);
  });

  await asyncTest("Executes a workflow using simulated tools", async () => {
    const demoWorkflow = {
      id: "demo",
      version: "1.0.0",
      inputs: [{ name: "topic", type: "string", required: true }],
      allowedTools: ["demo_search", "demo_summarize"],
      steps: [
        {
          id: "search",
          tool: "demo_search",
          dependsOn: [],
          approval: "none",
        },
        {
          id: "summarize",
          tool: "demo_summarize",
          dependsOn: ["search"],
          approval: "none",
        },
      ],
    };

    const demoRun = engine.createWorkflowRun(demoWorkflow, {
      topic: "Test topic",
    });

    const result = await engine.executeWorkflow(demoWorkflow, demoRun, {
      executeTool: async (tool, context) => ({
        success: true,
        data: { tool, stepId: context.stepId },
      }),
      persist: async () => {},
      recordEvent: async () => {},
    });

    assert.equal(result.status, "completed");
    assert.ok(result.steps.every(s => s.state === "succeeded"));
  });

  await asyncTest("Does not treat unsuccessful tools as successes", async () => {
    const demoWorkflow = {
      id: "failure-demo",
      inputs: [],
      allowedTools: ["demo_tool"],
      steps: [{
        id: "step",
        tool: "demo_tool",
        dependsOn: [],
        approval: "none",
      }],
    };

    const demoRun = engine.createWorkflowRun(demoWorkflow);

    const result = await engine.executeWorkflow(demoWorkflow, demoRun, {
      executeTool: async () => ({
        success: false,
        error: "Simulated tool failure",
      }),
      persist: async () => {},
      recordEvent: async () => {},
    });

    assert.equal(result.steps[0].state, "failed");
    assert.equal(result.steps[0].attempts, 2);
    assert.match(result.steps[0].error, /Simulated tool failure/);
  });

  console.log(`\n${passed} tests passed.`);
}

main().catch(error => {
  console.error("\nTest suite stopped:", error);
  process.exitCode = 1;
});
