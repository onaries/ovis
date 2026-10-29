import { createContext, useContext, useMemo } from "react";
import * as api from "./api.ts";
import type { CreateWorktreeRequest, OpenWorktreeRequest, PaneDirection, PluginActionRequest, RemoveWorktreeRequest, SessionHistoryAgent, SessionResumeRequest, SplitPaneDirection } from "../../shared/protocol.ts";
import type { ZoomMode } from "./layoutMap.ts";
import { ReorderCoordinator } from "./workspaceOrder.ts";
export const MachineContext = createContext("local");
export const useMachineId = () => useContext(MachineContext);
/** App's workspace order for every PC (lib/workspaceOrder.ts); a Sidebar outside App gets its own */
export const ReorderContext = createContext(new ReorderCoordinator());
export const useReorderCoordinator = () => useContext(ReorderContext);
/** Bound functions retain their owner across an async upload or a fast PC switch. */
export function useMachineApi() {
  const id = useMachineId();
  return useMemo(() => ({
    fetchPaneTranscript: (pane: string, lines: number) => api.fetchPaneTranscript(pane, lines, id),
    fetchPaneConversation: (pane: string, page?: api.ConversationPageQuery) => api.fetchPaneConversation(pane, id, page),
    peekPaneConversation: (pane: string, page?: number | api.ConversationPageQuery) => api.peekPaneConversation(pane, id, page),
    fetchPanePrompt: (pane: string) => api.fetchPanePrompt(pane, id),
    fetchPanePromptState: (pane: string) => api.fetchPanePromptState(pane, id),
    answerPanePrompt: (answer: Parameters<typeof api.answerPanePrompt>[0]) => api.answerPanePrompt(answer, id),
    uploadPaneImage: (pane: string, image: Blob) => api.uploadPaneImage(pane, image, id),
    fetchPaneCommands: (pane: string) => api.fetchPaneCommands(pane, id),
    fetchAgentCommands: (agent: string, cwd: string | null) => api.fetchAgentCommands(agent, cwd, id),
    fetchPaneFiles: (pane: string, query: string, limit = 20) => api.fetchPaneFiles(pane, query, limit, id),
    findPane: (request: Parameters<typeof api.findPane>[0]) => api.findPane(request, id),
    fetchPaneScroll: (pane: string) => api.fetchPaneScroll(pane, id),
    scrollPane: (pane: string, offset: number) => api.scrollPane(pane, offset, id),
    fetchPaneOmoActivity: (pane: string) => api.fetchPaneOmoActivity(pane, id),
    fetchPaneBackgroundAgent: (pane: string, agent: string) => api.fetchPaneBackgroundAgent(pane, agent, id),
    fetchPanePlan: (pane: string) => api.fetchPanePlan(pane, id),
    closePane: (pane: string) => api.closePane(pane, id),
    focusPane: (pane: string) => api.focusPane(pane, id),
    closeWorkspace: (workspace: string, closeGroup = false) => api.closeWorkspace(workspace, id, closeGroup),
    createWorktree: (request: CreateWorktreeRequest) => api.createWorktree(request, id),
    listWorktrees: (workspace: string) => api.listWorktrees(workspace, id),
    openWorktree: (request: OpenWorktreeRequest) => api.openWorktree(request, id),
    removeWorktree: (request: RemoveWorktreeRequest) => api.removeWorktree(request, id),
    renamePane: (pane: string, label: string) => api.renamePane(pane, label, id),
    renameAgent: (pane: string, name: string | null) => api.renameAgent(pane, name, id),
    splitPane: (pane: string, direction: SplitPaneDirection, focus = false) => api.splitPane(pane, direction, focus, id),
    zoomPane: (pane: string, mode: ZoomMode) => api.zoomPane(pane, mode, id),
    swapPane: (pane: string, direction: PaneDirection) => api.swapPane(pane, direction, id),
    swapPaneWith: (pane: string, target: string) => api.swapPaneWith(pane, target, id),
    setSplitRatio: (tab: string, path: boolean[], ratio: number) => api.setSplitRatio(tab, path, ratio, id),
    resizePane: (pane: string, direction: PaneDirection) => api.resizePane(pane, direction, id),
    clearPane: (pane: string) => api.clearPane(pane, id),
    renameWorkspace: (workspace: string, label: string) => api.renameWorkspace(workspace, label, id),
    moveWorkspace: (workspace: string, index: number) => api.moveWorkspace(workspace, index, id),
    fetchAgentKinds: () => api.fetchAgentKinds(id),
    fetchIntegrations: () => api.fetchIntegrations(id),
    fetchDirectories: (path: string, hidden: boolean, files = false, pane: string | null = null) => api.fetchDirectories(path, hidden, id, files, pane),
    createDirectory: (path: string, name: string) => api.createDirectory(path, name, id),
    fetchFileInfo: (path: string, pane: string | null) => api.fetchFileInfo(path, pane, id),
    fileUrl: (path: string, pane: string | null, download = false) => api.fileUrl(path, pane, id, download),
    fetchRepoDiffFiles: (query: api.RepoDiffQuery) => api.fetchRepoDiffFiles(query, id),
    fetchRepoDiffRepositories: (query: Pick<api.RepoDiffQuery, "paneId" | "directory">, children: boolean, depth: number) => api.fetchRepoDiffRepositories(query, children, depth, id),
    fetchRepoDiffFile: (query: api.RepoDiffQuery, path: string, oldPath: string | null) => api.fetchRepoDiffFile(query, path, oldPath, id),
    fetchRepoDiffRefs: (query: Pick<api.RepoDiffQuery, "paneId" | "directory">) => api.fetchRepoDiffRefs(query, id),
    createWorkspace: (request: api.CreateWorkspaceRequest) => api.createWorkspace(request, id),
    createTab: (request: api.CreateTabRequest) => api.createTab(request, id),
    fetchSessionHistory: (workspace: string, agent: SessionHistoryAgent, pane: string | null = null) => api.fetchSessionHistory(workspace, agent, id, pane),
    resumeSession: (request: SessionResumeRequest) => api.resumeSession(request, id),
    sessionHistoryOffered: () => api.sessionHistoryOffered(id),
    renameTab: (tab: string, label: string) => api.renameTab(tab, label, id),
    closeTab: (tab: string) => api.closeTab(tab, id),
    moveTab: (tab: string, index: number) => api.moveTab(tab, index, id),
    moveTabToWorkspace: (tab: string, workspace: string) => api.moveTabToWorkspace(tab, workspace, id),
    fetchPluginActions: () => api.fetchPluginActions(id),
    runPluginAction: (request: PluginActionRequest) => api.runPluginAction(request, id),
    fetchPluginActionStatus: (pluginId: string, logId: string) => api.fetchPluginActionStatus(pluginId, logId, id),
  }), [id]);
}
