
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const RUNS_FILE = path.join(DATA_DIR, "workflow-runs.json");
const EVENTS_FILE = path.join(DATA_DIR, "task-events.json");

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readArray(file) {
  ensureDataDir();

  if (!fs.existsSync(file)) return [];

  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array in ${path.basename(file)}.`);
  }

  return parsed;
}

function writeArray(file, data) {
  ensureDataDir();

  const temporary = `${file}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify(data, null, 2),
    "utf8"
  );
  fs.renameSync(temporary, file);
}

function saveRun(run) {
  const runs = readArray(RUNS_FILE);
  const index = runs.findIndex(item => item.runId === run.runId);

  if (index === -1) {
    runs.push(run);
  } else {
    runs[index] = run;
  }

  writeArray(RUNS_FILE, runs);
  return run;
}

function getRun(runId) {
  return readArray(RUNS_FILE).find(run => run.runId === runId) || null;
}

function listRuns() {
  return readArray(RUNS_FILE);
}

function recordEvent(event) {
  // Keep logs compact: never store prompts, secrets, or tool result bodies.
  const safeEvent = {
    timestamp: new Date().toISOString(),
    type: String(event.type || "unknown"),
    workflowId: event.workflowId || null,
    runId: event.runId || null,
    stepId: event.stepId || null,
  };

  if (event.tool) safeEvent.tool = String(event.tool);
  if (Number.isInteger(event.attempt)) safeEvent.attempt = event.attempt;
  if (typeof event.retrying === "boolean") {
    safeEvent.retrying = event.retrying;
  }

  if (event.error) {
    safeEvent.error = String(event.error).slice(0, 300);
  }

  const events = readArray(EVENTS_FILE);
  events.push(safeEvent);
  writeArray(EVENTS_FILE, events);

  return safeEvent;
}

function listEvents(runId) {
  return readArray(EVENTS_FILE).filter(
    event => !runId || event.runId === runId
  );
}

module.exports = {
  saveRun,
  getRun,
  listRuns,
  recordEvent,
  listEvents,
};
