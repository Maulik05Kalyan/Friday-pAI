const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  askAI: (messages) => ipcRenderer.invoke("ask-ai", messages),
});