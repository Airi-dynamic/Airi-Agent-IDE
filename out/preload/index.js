"use strict";
const electron = require("electron");
const preload = require("@electron-toolkit/preload");
const api = {};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", preload.electronAPI);
    electron.contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error("Failed to expose APIs in the main world:", error);
  }
} else {
  window.electron = preload.electronAPI;
  window.api = api;
}
