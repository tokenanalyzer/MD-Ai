import React from "react";
import { colors } from "../../../theme/tokens";
import { useSceneGraph } from "./useSceneGraph";
import { useReducedMotion } from "./useReducedMotion";
import { MasterCore } from "./MasterCore";
import { AgentNode } from "./AgentNode";
import { ConnectionLine } from "./ConnectionLine";
import { Particles } from "./Particles";
import { NODE_RADIUS } from "./constants";

interface Props {
  particleCount: number;
}

/**
 * The full scene graph: real Master Core state, real per-agent nodes,
 * real delegation connections, all sourced from useSceneGraph.ts (which
 * itself reads the same stores as M6's 2D panels). This component is the
 * one thing Canvas3D.native.tsx/.web.tsx mount inside <Canvas> — no
 * platform-specific logic lives here.
 */
export function Scene({ particleCount }: Props) {
  const scene = useSceneGraph();
  const reducedMotion = useReducedMotion();

  return (
    <>
      <ambientLight intensity={0.5} color={colors.textPrimary} />
      <pointLight position={[2, 2, 2]} intensity={0.4} color={colors.secondary} />

      <MasterCore active={scene.masterActive} pulse={scene.masterPulse} reducedMotion={reducedMotion} />

      {scene.nodes.map((node) => (
        <AgentNode key={node.id} node={node} radius={NODE_RADIUS} reducedMotion={reducedMotion} />
      ))}

      {scene.connections.map((connection) => {
        const node = scene.nodes.find((n) => n.id === connection.toId);
        if (!node) return null;
        return (
          <ConnectionLine key={connection.id} connection={connection} angle={node.angle} radius={NODE_RADIUS} reducedMotion={reducedMotion} />
        );
      })}

      <Particles count={particleCount} reducedMotion={reducedMotion} />
    </>
  );
}
