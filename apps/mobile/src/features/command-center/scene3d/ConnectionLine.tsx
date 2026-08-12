import React, { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { colors } from "../../../theme/tokens";
import { ORBIT_SPEED } from "./constants";
import type { SceneConnection } from "./sceneTypes";

interface Props {
  connection: SceneConnection;
  angle: number;
  radius: number;
  reducedMotion: boolean;
}

/**
 * A line from the Master Core to one agent node, brightened only while
 * `connection.pulsing` is true — set by useSceneGraph.ts exclusively in
 * response to a real `task.created` (delegation) event. Idle connections
 * stay faint; nothing here fabricates activity.
 */
export function ConnectionLine({ connection, angle, radius, reducedMotion }: Props) {
  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({ color: colors.border, transparent: true, opacity: 0.25 });
    return new THREE.Line(geometry, material);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const material = line.material as THREE.LineBasicMaterial;
    material.color.set(connection.pulsing ? colors.accent : colors.border);
    material.opacity = connection.pulsing ? 0.85 : 0.25;
  }, [connection.pulsing, line]);

  useFrame(() => {
    const orbitAngle = reducedMotion ? 0 : (performance.now() / 1000) * ORBIT_SPEED;
    const a = angle + orbitAngle;
    const depthOffset = Math.sin(angle * 2) * 0.3;
    const positions = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    positions.setXYZ(0, 0, 0, 0);
    positions.setXYZ(1, Math.cos(a) * radius, depthOffset, Math.sin(a) * radius);
    positions.needsUpdate = true;
  });

  return <primitive object={line} />;
}
