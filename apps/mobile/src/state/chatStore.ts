import { create } from "zustand";
import { cancelTask, createConversation, sendMessage, type RoutingMode } from "../api/client";
import { buildProviderKeysForRequest } from "../security/secureVault";
import { openTaskStream } from "../realtime/chatSocket";

export type ChatMessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  text: string;
  streaming?: boolean;
}

export type ConnectionState = "idle" | "working" | "error";

interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  connection: ConnectionState;
  lastError: string | null;
  activeTaskId: string | null;
  /** M6 Current Task panel's elapsed-time display — client-side timestamp (`Date.now()`) set when a task's request goes out, cleared when it settles. Not a backend field; purely local UI timing. */
  activeTaskStartedAt: number | null;
  /** M3.9: latest safe delegation status label (e.g. "Research Agent working…"), cleared once the task settles. */
  progressLabel: string | null;
  preferredProviderId?: string;
  preferredModelId?: string;
  /** M2.5: AUTO defers to the deterministic scoring router; MANUAL always uses preferredProviderId/preferredModelId exactly. */
  routingMode: RoutingMode;

  ensureConversation: () => Promise<string>;
  setPreferredProvider: (providerId?: string) => void;
  setManualModel: (providerId: string, modelId?: string) => void;
  setRoutingMode: (mode: RoutingMode) => void;
  send: (text: string) => Promise<void>;
  retryLast: () => Promise<void>;
  cancelActive: () => Promise<void>;
}

let closeStream: (() => void) | null = null;
let lastUserText: string | null = null;

export const useChatStore = create<ChatState>((set, get) => ({
  conversationId: null,
  messages: [],
  connection: "idle",
  lastError: null,
  activeTaskId: null,
  activeTaskStartedAt: null,
  progressLabel: null,
  preferredProviderId: undefined,
  preferredModelId: undefined,
  routingMode: "auto",

  ensureConversation: async () => {
    const existing = get().conversationId;
    if (existing) return existing;
    const conv = await createConversation("MD AI Chat");
    set({ conversationId: conv.id });
    return conv.id;
  },

  setPreferredProvider: (providerId) => set({ preferredProviderId: providerId }),
  setManualModel: (providerId, modelId) => set({ preferredProviderId: providerId, preferredModelId: modelId }),
  setRoutingMode: (mode) => set({ routingMode: mode }),

  send: async (text: string) => {
    lastUserText = text;
    const conversationId = await get().ensureConversation();
    const providerKeys = await buildProviderKeysForRequest();

    if (Object.keys(providerKeys).length === 0) {
      set({ connection: "error", lastError: "No provider configured yet — add an API key in Settings first." });
      return;
    }
    if (get().routingMode === "manual" && !get().preferredProviderId) {
      set({ connection: "error", lastError: "MANUAL mode needs a provider selected in the Vault screen first." });
      return;
    }

    const userMsg: ChatMessage = { id: `local-${Date.now()}`, role: "user", text };
    const assistantMsg: ChatMessage = { id: `local-${Date.now()}-a`, role: "assistant", text: "", streaming: true };
    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      connection: "working",
      lastError: null,
      progressLabel: null,
      activeTaskStartedAt: Date.now(),
    }));

    try {
      const task = await sendMessage(conversationId, {
        text,
        providerKeys,
        preferredProviderId: get().preferredProviderId,
        preferredModelId: get().preferredModelId,
        routingMode: get().routingMode,
      });
      set({ activeTaskId: task.id });

      closeStream?.();
      closeStream = await openTaskStream(task.id, {
        onDelta: (delta) => {
          set((s) => ({
            progressLabel: null,
            messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, text: m.text + delta } : m)),
          }));
        },
        onProgress: (label) => {
          set({ progressLabel: label });
        },
        onStatus: (state) => {
          if (state === "completed") {
            set((s) => ({
              connection: "idle",
              activeTaskId: null,
              activeTaskStartedAt: null,
              progressLabel: null,
              messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)),
            }));
          } else if (state === "failed" || state === "canceled") {
            set((s) => ({
              connection: state === "failed" ? "error" : "idle",
              activeTaskId: null,
              activeTaskStartedAt: null,
              progressLabel: null,
              lastError: state === "failed" ? "The model didn't respond — check your provider keys and try again." : null,
              messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)),
            }));
          }
        },
        onError: () => {
          set({ connection: "error", lastError: "Lost connection to MD AI backend.", activeTaskId: null, activeTaskStartedAt: null, progressLabel: null });
        },
        onClose: () => {
          closeStream = null;
        },
      });
    } catch (err) {
      set({
        connection: "error",
        lastError: err instanceof Error ? err.message : "Failed to send message",
        activeTaskId: null,
        activeTaskStartedAt: null,
      });
    }
  },

  retryLast: async () => {
    if (lastUserText) await get().send(lastUserText);
  },

  cancelActive: async () => {
    const taskId = get().activeTaskId;
    if (!taskId) return;
    await cancelTask(taskId);
  },
}));
