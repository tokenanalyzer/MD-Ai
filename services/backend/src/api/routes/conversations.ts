import { Router } from "express";
import type pg from "pg";
import type { AgentRegistry, ChatMessage, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../../core/events/eventBus.js";
import type { ToolRegistryService } from "../../core/mcp/toolRegistryService.js";
import { authGuard } from "../middleware/authGuard.js";
import { AppError } from "../errors.js";
import { createConversationBodySchema, sendMessageBodySchema } from "../schemas.js";
import {
  addTaskMessage,
  createConversation,
  createTask,
  getConversation,
  listConversations,
  listTaskMessages,
  listTasksForConversation,
  patchTaskInput,
  type TaskRow,
} from "../../db/repositories/taskRepo.js";
import { dispatchMasterAgentTask } from "../chatOrchestrator.js";

const SYSTEM_PROMPT =
  "You are the Master Agent inside MD AI, a private single-user personal intelligence system. " +
  "Answer directly and concisely. You are speaking with your one owner, not the public.";

function toTaskDto(task: TaskRow) {
  return {
    id: task.id,
    conversationId: task.conversation_id,
    assignedAgentId: task.assigned_agent_id,
    taskType: task.task_type,
    state: task.state,
    modelId: task.model_id,
    createdAt: task.created_at.toISOString(),
    updatedAt: task.updated_at.toISOString(),
  };
}

async function buildConversationHistory(pool: pg.Pool, conversationId: string): Promise<ChatMessage[]> {
  const tasks = await listTasksForConversation(pool, conversationId);
  const messages: ChatMessage[] = [];
  for (const t of tasks) {
    const taskMessages = await listTaskMessages(pool, t.id);
    for (const tm of taskMessages) {
      if (tm.role !== "user" && tm.role !== "agent") continue;
      const text = tm.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (!text) continue;
      messages.push({ role: tm.role === "agent" ? "assistant" : "user", content: text });
    }
  }
  return messages;
}

export function conversationsRouter(
  pool: pg.Pool,
  eventBus: EventBus,
  modelRegistry: ModelRegistry,
  agentRegistry: AgentRegistry,
  toolRegistry: ToolRegistryService,
): Router {
  const router = Router();
  router.use(authGuard(pool));

  router.get("/", async (_req, res, next) => {
    try {
      const conversations = await listConversations(pool);
      res.json({
        data: conversations.map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: c.created_at.toISOString(),
          updatedAt: c.updated_at.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = createConversationBodySchema.parse(req.body ?? {});
      const conversation = await createConversation(pool, body.title);
      res.status(201).json({
        data: { id: conversation.id, title: conversation.title, createdAt: conversation.created_at.toISOString() },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/tasks", async (req, res, next) => {
    try {
      const conversation = await getConversation(pool, req.params.id as string);
      if (!conversation) throw AppError.notFound("Conversation not found");
      const tasks = await listTasksForConversation(pool, conversation.id);
      const withMessages = await Promise.all(
        tasks.map(async (t) => ({
          ...toTaskDto(t),
          messages: (await listTaskMessages(pool, t.id)).map((m) => ({
            id: m.id,
            role: m.role,
            fromAgentId: m.from_agent_id,
            parts: m.parts,
            createdAt: m.created_at.toISOString(),
          })),
        })),
      );
      res.json({ data: withMessages });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/messages", async (req, res, next) => {
    try {
      const conversation = await getConversation(pool, req.params.id as string);
      if (!conversation) throw AppError.notFound("Conversation not found");

      const body = sendMessageBodySchema.parse(req.body);
      if (body.routingMode === "manual" && !body.preferredProviderId) {
        throw AppError.badRequest("routingMode 'manual' requires preferredProviderId");
      }
      const currentUserText = body.parts.map((p) => p.text).join("\n");

      const task = await createTask(pool, {
        conversationId: conversation.id,
        assignedAgentId: "master",
        taskType: "chat",
        inputPayload: {
          parts: body.parts,
          currentUserText,
          preferredProviderId: body.preferredProviderId,
          preferredModelId: body.preferredModelId,
          taskCategory: body.taskCategory,
          routingMode: body.routingMode,
        },
      });
      await addTaskMessage(pool, { taskId: task.id, role: "user", parts: body.parts });
      await eventBus.publish({
        sourceType: "agent",
        sourceId: "master",
        taskId: task.id,
        payload: {
          type: "task.created",
          taskId: task.id,
          assignedAgentId: "master",
          taskType: task.task_type,
          correlationId: task.correlation_id ?? undefined,
        },
      });

      // Master reads its full request-scoped input (routing preferences,
      // the full message list to synthesize from) off the task row rather
      // than through extra handleTask() arguments, since `Agent.handleTask`
      // only takes an `AgentRuntimeContext` — see
      // core/agents/master/masterAgent.ts. The message list can only be
      // assembled now, once this task's own just-added user message is
      // visible to buildConversationHistory.
      const history = await buildConversationHistory(pool, conversation.id);
      const conversationMessages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
      const finalTask = await patchTaskInput(pool, task.id, { conversationMessages });

      dispatchMasterAgentTask({
        pool,
        eventBus,
        modelRegistry,
        agentRegistry,
        toolRegistry,
        task: finalTask,
        providerKeys: body.providerKeys,
        toolKeys: body.toolKeys ?? {},
      });

      res.status(201).json({ data: toTaskDto(finalTask) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
