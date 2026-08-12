import React, { useRef } from "react";
import { router } from "expo-router";
import type * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { colors } from "../../../theme/tokens";
import { ORBIT_SPEED } from "./constants";
import type { SceneAgentNode } from "./sceneTypes";

interface Props {
  node: SceneAgentNode;
  radius: number;
  reducedMotion: boolean;
}

function activityColor(activity: SceneAgentNode["activity"]): string {
  switch (activity) {
    case "pulse":
      return colors.accent;
    case "working":
      return colors.secondary;
    case "error":
      return colors.danger;
    case "disabled":
      return colors.textTertiary;
    default:
      return colors.textSecondary;
  }
}

/**
 * One registered agent, positioned on a ring around the Master Core.
 * Color/pulse encode `activity` (idle/working/pulse/error/disabled) —
 * every state here traces to real Agent Registry status or a live event
 * (useSceneGraph.ts), never a decorative default. Tapping opens the same
 * Agent Detail screen the 2D Agent Center uses (M6.5) — no separate data
 * system for "3D agent info."
 */
export function AgentNode({ node, radius, reducedMotion }: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const depthOffset = Math.sin(node.angle * 2) * 0.3;

  useFrame(() => {
    if (!meshRef.current) return;
    const orbitAngle = reducedMotion ? 0 : (performance.now() / 1000) * ORBIT_SPEED;
    const angle = node.angle + orbitAngle;
    meshRef.current.position.set(Math.cos(angle) * radius, depthOffset, Math.sin(angle) * radius);

    const pulseScale = node.activity === "pulse" ? 1 + Math.sin(performance.now() / 140) * 0.18 : node.activity === "disabled" ? 0.7 : 1;
    meshRef.current.scale.setScalar(pulseScale);
  });

  const color = activityColor(node.activity);
  const opacity = node.activity === "disabled" ? 0.35 : 1;

  return (
    <mesh
      ref={meshRef}
      onClick={(e) => {
        e.stopPropagation();
        router.push(`/(agents)/${node.id}`);
      }}
    >
      <sphereGeometry args={[0.16, 20, 20]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={node.activity === "idle" ? 0.15 : 0.6} transparent opacity={opacity} />
    </mesh>
  );
}
