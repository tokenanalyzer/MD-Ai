export type NodeActivity = "idle" | "working" | "pulse" | "error" | "disabled";

export interface SceneAgentNode {
  id: string;
  displayName: string;
  /** Position around the ring, radians — purely a layout computation (index / count), never a hardcoded roster. */
  angle: number;
  activity: NodeActivity;
}

export interface SceneConnection {
  id: string;
  fromId: string;
  toId: string;
  pulsing: boolean;
}

export type MasterPulse = "none" | "completion" | "memory";

export interface SceneState {
  masterActive: boolean;
  masterPulse: MasterPulse;
  nodes: SceneAgentNode[];
  connections: SceneConnection[];
}
