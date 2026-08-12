/** Radians/second — shared by AgentNode and ConnectionLine so orbit position stays in sync without any lifted state (each computes `performance.now() * ORBIT_SPEED` independently, which is deterministic and always agrees). */
export const ORBIT_SPEED = 0.12;
export const NODE_RADIUS = 1.5;

export const CAMERA_DEFAULT = { theta: 0.7, phi: 1.1, radius: 4.2 };
export const CAMERA_MIN_RADIUS = 2.2;
export const CAMERA_MAX_RADIUS = 8;
export const CAMERA_MIN_PHI = 0.35;
export const CAMERA_MAX_PHI = Math.PI - 0.35;
