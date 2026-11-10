import { contextBridge, ipcRenderer } from "electron";
import type { WorkbenchApi } from "../shared/types";

const api: WorkbenchApi = {
  rateTextTopic: (jobId, clipId, verdict, reason) => ipcRenderer.invoke('text:topic-feedback', jobId, clipId, verdict, reason),
  clearTextTopicFeedback: (jobId, clipId) => ipcRenderer.invoke('text:clear-topic-feedback', jobId, clipId),
  confirmTextFinal: (jobId, clipId, note, expectedEdit) => ipcRenderer.invoke('text:confirm-final', jobId, clipId, note, expectedEdit),
  withdrawTextFinal: (jobId, clipId) => ipcRenderer.invoke('text:withdraw-final', jobId, clipId),
  listTextJobs: () => ipcRenderer.invoke('text:list'),
  getTextLearningSummary: () => ipcRenderer.invoke('text:learning-summary'),
  getTextExportDestinations: () => ipcRenderer.invoke('text:export-destinations'),
  startTextJobs: inputs => ipcRenderer.invoke('text:start', inputs),
  retryTextJob: jobId => ipcRenderer.invoke('text:retry', jobId),
  dismissTextJob: jobId => ipcRenderer.invoke('text:dismiss', jobId),
  renameTextJob: (jobId, name, teacher) => ipcRenderer.invoke('text:rename', jobId, name, teacher),
  readTextTranscript: jobId => ipcRenderer.invoke('text:transcript', jobId),
  supplementTextJob: (jobId, startMs, endMs) => ipcRenderer.invoke('text:supplement', jobId, startMs, endMs),
  importTextSubtitle: jobId => ipcRenderer.invoke('text:subtitle', jobId),
  saveTextClip: (jobId, clipId, edit) => ipcRenderer.invoke('text:save', jobId, clipId, edit),
  reviewTextClip: (jobId, clipId) => ipcRenderer.invoke('text:review', jobId, clipId),
  syncTextClip: (jobId, clipId) => ipcRenderer.invoke('text:sync', jobId, clipId),
  exportTextClip: (jobId, clipId, folder, teacher) => ipcRenderer.invoke('text:export', jobId, clipId, folder, teacher),
  connectFeishuDocument: () => ipcRenderer.invoke('text:connect-feishu'),
  openFeishuDocument: url => ipcRenderer.invoke('text:open-feishu-document', url),
  openTextSource: jobId => ipcRenderer.invoke('text:open-source', jobId),
  getSnapshot: () => ipcRenderer.invoke("snapshot:get"),
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  saveAccount: (input) => ipcRenderer.invoke("accounts:save", input),
  learnAccountSamples: (accountId, samplePaths) =>
    ipcRenderer.invoke("accounts:learn-samples", { accountId, samplePaths }),
  deleteAccount: (id) => ipcRenderer.invoke("accounts:delete", id),
  selectFiles: (options) => ipcRenderer.invoke("files:select", options),
  createTask: (input) => ipcRenderer.invoke("tasks:create", input),
  attachTaskFiles: (input) => ipcRenderer.invoke("tasks:attach-files", input),
  importBatch: (csvPath) => ipcRenderer.invoke("tasks:import-batch", csvPath),
  inspectSource: (url) => ipcRenderer.invoke("sources:inspect", url),
  openSourceLogin: (url) => ipcRenderer.invoke("sources:login", url),
  runTask: (taskId) => ipcRenderer.invoke("tasks:run", taskId),
  pauseTask: (taskId) => ipcRenderer.invoke("tasks:pause", taskId),
  rebuildCandidates: (taskId) => ipcRenderer.invoke("tasks:rebuild-candidates", taskId),
  deleteTask: (taskId) => ipcRenderer.invoke("tasks:delete", taskId),
  listCandidates: (taskId) => ipcRenderer.invoke("candidates:list", taskId),
  generateCandidatePreview: (candidateId) =>
    ipcRenderer.invoke("candidates:preview", candidateId),
  deleteCandidate: (candidateId) => ipcRenderer.invoke("candidates:delete", candidateId),
  saveCandidate: (candidate) =>
    ipcRenderer.invoke("candidates:save", candidate),
  ensureCandidateWordTimings: (candidate) =>
    ipcRenderer.invoke("candidates:ensure-word-timings", candidate),
  saveCandidateAndPreview: (candidate) =>
    ipcRenderer.invoke("candidates:save-and-preview", candidate),
  reviewCandidate: (input) => ipcRenderer.invoke("candidates:review", input),
  acknowledgeRisk: (input) => ipcRenderer.invoke("candidates:ack-risk", input),
  exportCandidate: (candidateId) =>
    ipcRenderer.invoke("export:candidate", candidateId),
  exportCandidates: (candidateIds) =>
    ipcRenderer.invoke("export:candidates", candidateIds),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("settings:save", input),
  testModelConnection: (input) => ipcRenderer.invoke("model:test-connection", input),
  openPath: (targetPath) => ipcRenderer.invoke("shell:open-path", targetPath),
  savePerformance: (input) => ipcRenderer.invoke("performance:save", input),
  listPerformance: (candidateId) =>
    ipcRenderer.invoke("performance:list", candidateId),
  getBlindTestSnapshot: () => ipcRenderer.invoke("blind-test:snapshot"),
  saveBlindTestSession: (input) =>
    ipcRenderer.invoke("blind-test:save-session", input),
  backupNow: () => ipcRenderer.invoke("backup:now"),
  checkForUpdate: () => ipcRenderer.invoke("updates:check"),
  getFeishuStatus: () => ipcRenderer.invoke("feishu:status"),
  connectFeishu: () => ipcRenderer.invoke("feishu:connect"),
  disconnectFeishu: () => ipcRenderer.invoke("feishu:disconnect"),
  testFeishuUpdateFolder: () => ipcRenderer.invoke("feishu:test-folder"),
  installUpdate: (request) => ipcRenderer.invoke("updates:install", request),
  publishUpdate: (notes) => ipcRenderer.invoke("updates:publish", notes),
};

contextBridge.exposeInMainWorld("workbench", api);
