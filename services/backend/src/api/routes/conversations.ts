import { Router } from "express";
import type pg from "pg";
import type { ChatMessage, ModelRegistry } from "@mdai/shared-types";
import type { EventBus } from "../../core/events/eventBus.js";
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
  type TaskRow,
} from "../../db/repositories/taskRepo.js";
import { startMasterAgentTask } from "../chatOrchestrator.js";

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

export function conversationsRouter(pool: pg.Pool, eventBus: EventBus, modelRegistry: ModelRegistry): Router {
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
      const task = await createTask(pool, {
        conversationId: conversation.id,
        assignedAgentId: "master",
        taskType: "chat",
        inputPayload: { parts: body.parts },
      });
      await addTaskMessage(pool, { taskId: task.id, role: "user", parts: body.parts });
      await eventBus.publish({
        sourceType: "agent",
        sourceId: "master",
        taskId: task.id,
        payload: { type: "agent.task.created", agentId: "master", taskId: task.id, taskType: task.task_type },
      });

      const history = await buildConversationHistory(pool, conversation.id);
      const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

      startMasterAgentTask({
        pool,
        eventBus,
        modelRegistry,
        task,
        messages,
        providerKeys: body.providerKeys,
        preferredProviderId: body.preferredProviderId,
        preferredModelId: body.preferredModelId,
        taskCategory: body.taskCategory,
        routingMode: body.routingMode,
      });

      res.status(201).json({ data: toTaskDto(task) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
