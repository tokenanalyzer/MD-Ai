import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useChatStore } from "../../../state/chatStore";
import { useEventsStore } from "../../../state/eventsStore";
import type { EventDto } from "../../../api/client";
import type { MasterPulse, SceneAgentNode, SceneConnection, SceneState } from "./sceneTypes";

const PULSE_MS = 1600;
const CONNECTION_PULSE_MS = 2000;
const MASTER_PULSE_MS = 1400;

/**
 * M7: derives the entire 3D scene's state from the same real sources M6's
 * 2D panels already read — `useAgentsStore` (GET /agents, Agent Registry)
 * for the roster/base status, `useChatStore` for whether Master is
 * actively working on the current chat task, and `useEventsStore`'s live
 * event stream for every transient activity pulse. Nothing here is
 * synthesized: every pulse traces to one real backend event
 * (docs/architecture/05-event-schemas.md), and if no real event has fired,
 * the scene stays calm — no idle-time fake animation.
 */
export function useSceneGraph(): SceneState {
  const agents = useAgentsStore((s) => s.agents);
  const loadAgents = useAgentsStore((s) => s.loadAgents);
  const chatWorking = useChatStore((s) => s.connection === "working");
  const events = useEventsStore((s) => s.events);
  const liveIds = useEventsStore((s) => s.liveIds);
  const connectEvents = useEventsStore((s) => s.connect);

  useEffect(() => {
    if (agents.length === 0) void loadAgents();
    void connectEvents();
  }, [agents.length, loadAgents, connectEvents]);

  const [activeAgentIds, setActiveAgentIds] = useState<Set<string>>(new Set());
  const [pulsingAgentIds, setPulsingAgentIds] = useState<Set<string>>(new Set());
  const [pulsingConnections, setPulsingConnections] = useState<Set<string>>(new Set());
  const [masterPulse, setMasterPulse] = useState<MasterPulse>("none");

  const processedIds = useRef<Set<number>>(new Set());
  const toolInvocationAgent = useRef<Map<string, string>>(new Map());
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    },
    [],
  );

  function pulseAgent(agentId: string) {
    setPulsingAgentIds((s) => new Set(s).add(agentId));
    const t = setTimeout(() => {
      setPulsingAgentIds((s) => {
        const next = new Set(s);
        next.delete(agentId);
        return next;
      });
      timers.current.delete(t);
    }, PULSE_MS);
    timers.current.add(t);
  }

  function pulseConnection(fromId: string, toId: string) {
    const key = `${fromId}->${toId}`;
    setPulsingConnections((s) => new Set(s).add(key));
    const t = setTimeout(() => {
      setPulsingConnections((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
      timers.current.delete(t);
    }, CONNECTION_PULSE_MS);
    timers.current.add(t);
  }

  function flashMaster(kind: MasterPulse) {
    setMasterPulse(kind);
    const t = setTimeout(() => {
      setMasterPulse("none");
      timers.current.delete(t);
    }, MASTER_PULSE_MS);
    timers.current.add(t);
  }

  useEffect(() => {
    const fresh = events.filter((e) => liveIds.has(e.id) && !processedIds.current.has(e.id));
    if (fresh.length === 0) return;

    for (const event of fresh) {
      processedIds.current.add(event.id);
      applyEvent(event);
    }

    function applyEvent(event: EventDto) {
      const p = event.payload as Record<string, unknown>;
      switch (event.type) {
        case "agent.started":
        case "agent.task.started":
          setActiveAgentIds((s) => new Set(s).add(event.sourceId));
          pulseAgent(event.sourceId);
          break;
        case "agent.completed":
        case "agent.task.completed":
        case "agent.idle":
        case "agent.recovered":
          setActiveAgentIds((s) => {
            const next = new Set(s);
            next.delete(event.sourceId);
            return next;
          });
          break;
        case "agent.failed":
          setActiveAgentIds((s) => {
            const next = new Set(s);
            next.delete(event.sourceId);
            return next;
          });
          pulseAgent(event.sourceId);
          break;
        case "task.created": {
          const targetId = typeof p["assignedAgentId"] === "string" ? (p["assignedAgentId"] as string) : undefined;
          if (targetId) pulseConnection(event.sourceId, targetId);
          break;
        }
        case "task.completed": {
          const assigned = typeof p["assignedAgentId"] === "string" ? (p["assignedAgentId"] as string) : undefined;
          if (assigned === "master") flashMaster("completion");
          break;
        }
        case "tool.called": {
          const agentId = typeof p["agentId"] === "string" ? (p["agentId"] as string) : undefined;
          const invocationId = typeof p["invocationId"] === "string" ? (p["invocationId"] as string) : undefined;
          if (agentId) {
            pulseAgent(agentId);
            if (invocationId) toolInvocationAgent.current.set(invocationId, agentId);
          }
          break;
        }
        case "tool.completed":
        case "tool.failed": {
          const invocationId = typeof p["invocationId"] === "string" ? (p["invocationId"] as string) : undefined;
          const agentId = invocationId ? toolInvocationAgent.current.get(invocationId) : undefined;
          if (agentId) {
            pulseAgent(agentId);
            toolInvocationAgent.current.delete(invocationId as string);
          }
          break;
        }
        case "review.started":
          setActiveAgentIds((s) => new Set(s).add(event.sourceId));
          pulseAgent(event.sourceId);
          break;
        case "review.completed":
          setActiveAgentIds((s) => {
            const next = new Set(s);
            next.delete(event.sourceId);
            return next;
          });
          pulseAgent(event.sourceId);
          break;
        case "memory.retrieved":
          flashMaster("memory");
          break;
        default:
          break;
      }
    }
  }, [events, liveIds]);

  const others = useMemo(() => agents.filter((a) => a.id !== "master"), [agents]);

  const nodes: SceneAgentNode[] = useMemo(
    () =>
      others.map((agent, i) => {
        const angle = (i / Math.max(others.length, 1)) * Math.PI * 2;
        let activity: SceneAgentNode["activity"] = "idle";
        if (agent.status === "disabled") activity = "disabled";
        else if (agent.status === "error") activity = "error";
        else if (pulsingAgentIds.has(agent.id)) activity = "pulse";
        else if (activeAgentIds.has(agent.id) || agent.status === "working") activity = "working";
        return { id: agent.id, displayName: agent.displayName, angle, activity };
      }),
    [others, activeAgentIds, pulsingAgentIds],
  );

  const connections: SceneConnection[] = useMemo(
    () =>
      others.map((agent) => {
        const key = `master->${agent.id}`;
        return { id: key, fromId: "master", toId: agent.id, pulsing: pulsingConnections.has(key) };
      }),
    [others, pulsingConnections],
  );

  return {
    masterActive: chatWorking || activeAgentIds.has("master") || pulsingAgentIds.has("master"),
    masterPulse,
    nodes,
    connections,
  };
}
