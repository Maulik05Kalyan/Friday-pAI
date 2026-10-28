const { contextBridge, ipcRenderer } = require("electron");

// Expose only the specific IPC operations the renderer needs.
// Keep contextIsolation enabled and do not expose ipcRenderer directly.
contextBridge.exposeInMainWorld("electronAPI", {
  // Existing AI integration — preserved unchanged.
  askAI: (messages) => ipcRenderer.invoke("ask-ai", messages),
  getMemory: () => ipcRenderer.invoke("memory:list"),
  addMemory: (fact) => ipcRenderer.invoke("memory:add", fact),
  updateMemory: (payload) => ipcRenderer.invoke("memory:update", payload),
  deleteMemory: (text) => ipcRenderer.invoke("memory:delete", text),
  resetMemory: () => ipcRenderer.invoke("memory:reset"),
  getDefaultProjectPath: () => ipcRenderer.invoke("workflow:default-project-path"),
  chooseProjectPath: () => ipcRenderer.invoke("workflow:choose-project-path"),
  previewProjectOperation: (payload) => ipcRenderer.invoke("project-action:preview", payload),
  planProjectOperation: (payload) => ipcRenderer.invoke("project-action:plan", payload),
  executeProjectOperation: (token) => ipcRenderer.invoke("project-action:execute", token),

  // Workflow engine API.
  listWorkflows: () => ipcRenderer.invoke("workflow:list"),

  startWorkflow: (payload) =>
    ipcRenderer.invoke("workflow:start", payload),

  getWorkflowRun: (runId) =>
    ipcRenderer.invoke("workflow:get-run", runId),

  listWorkflowRuns: () =>
    ipcRenderer.invoke("workflow:list-runs"),

  listWorkflowEvents: (runId) =>
    ipcRenderer.invoke("workflow:list-events", runId),

  resumeWorkflow: (runId) =>
    ipcRenderer.invoke("workflow:resume", runId),

  cancelWorkflow: (runId) =>
    ipcRenderer.invoke("workflow:cancel", runId),

  resolveWorkflowApproval: (payload) =>
    ipcRenderer.invoke("workflow:approve", payload),
});
