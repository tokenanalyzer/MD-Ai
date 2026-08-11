import type pg from "pg";
import type { Part, TaskState } from "@mdai/shared-types";

export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export interface TaskRow {
  id: string;
  conversation_id: string | null;
  parent_task_id: string | null;
  created_by_agent: string | null;
  assigned_agent_id: string;
  task_type: string;
  state: TaskState;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  model_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskMessageRow {
  id: string;
  task_id: string;
  role: "user" | "agent" | "tool" | "system";
  from_agent_id: string | null;
  parts: Part[];
  created_at: Date;
}

export async function createConversation(pool: pg.Pool, title?: string): Promise<ConversationRow> {
  const { rows } = await pool.query<ConversationRow>(
    "INSERT INTO conversations (title) VALUES ($1) RETURNING *",
    [title ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create conversation");
  return row;
}

export async function getConversation(pool: pg.Pool, id: string): Promise<ConversationRow | undefined> {
  const { rows } = await pool.query<ConversationRow>("SELECT * FROM conversations WHERE id = $1", [id]);
  return rows[0];
}

export async function listConversations(pool: pg.Pool): Promise<ConversationRow[]> {
  const { rows } = await pool.query<ConversationRow>(
    "SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC",
  );
  return rows;
}

export async function createTask(
  pool: pg.Pool,
  input: {
    conversationId?: string;
    assignedAgentId: string;
    taskType: string;
    inputPayload: Record<string, unknown>;
  },
): Promise<TaskRow> {
  const { rows } = await pool.query<TaskRow>(
    `INSERT INTO tasks (conversation_id, assigned_agent_id, task_type, input, state)
     VALUES ($1, $2, $3, $4, 'submitted') RETURNING *`,
    [input.conversationId ?? null, input.assignedAgentId, input.taskType, input.inputPayload],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create task");
  return row;
}

export async function updateTaskState(
  pool: pg.Pool,
  id: string,
  patch: {
    state: TaskState;
    modelId?: string;
    output?: Record<string, unknown>;
    error?: Record<string, unknown>;
    startedAt?: boolean;
    completedAt?: boolean;
  },
): Promise<TaskRow> {
  const { rows } = await pool.query<TaskRow>(
    `UPDATE tasks SET
       state = $2,
       model_id = COALESCE($3, model_id),
       output = COALESCE($4, output),
       error = COALESCE($5, error),
       started_at = CASE WHEN $6 THEN now() ELSE started_at END,
       completed_at = CASE WHEN $7 THEN now() ELSE completed_at END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      patch.state,
      patch.modelId ?? null,
      patch.output ?? null,
      patch.error ?? null,
      Boolean(patch.startedAt),
      Boolean(patch.completedAt),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error(`Task ${id} not found`);
  return row;
}

export async function getTask(pool: pg.Pool, id: string): Promise<TaskRow | undefined> {
  const { rows } = await pool.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
  return rows[0];
}

export async function listTasksForConversation(pool: pg.Pool, conversationId: string): Promise<TaskRow[]> {
  const { rows } = await pool.query<TaskRow>(
    "SELECT * FROM tasks WHERE conversation_id = $1 ORDER BY created_at",
    [conversationId],
  );
  return rows;
}

export async function addTaskMessage(
  pool: pg.Pool,
  input: { taskId: string; role: TaskMessageRow["role"]; fromAgentId?: string; parts: Part[] },
): Promise<TaskMessageRow> {
  const { rows } = await pool.query<TaskMessageRow>(
    `INSERT INTO task_messages (task_id, role, from_agent_id, parts)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.taskId, input.role, input.fromAgentId ?? null, JSON.stringify(input.parts)],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to add task message");
  return row;
}

export async function listTaskMessages(pool: pg.Pool, taskId: string): Promise<TaskMessageRow[]> {
  const { rows } = await pool.query<TaskMessageRow>(
    "SELECT * FROM task_messages WHERE task_id = $1 ORDER BY created_at",
    [taskId],
  );
  return rows;
}
