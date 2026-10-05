const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // We'll add our desktop APIs here later
});