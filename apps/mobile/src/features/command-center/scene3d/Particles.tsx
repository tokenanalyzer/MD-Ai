import React, { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { colors } from "../../../theme/tokens";

interface Props {
  count: number;
  reducedMotion: boolean;
}

/**
 * A sparse, ambient particle field — purely decorative depth, capped low
 * (see `count`, set by Scene3DGate from a real device-memory check) and
 * never grown by activity, per "do not create fake activity merely to
 * make the scene look alive."
 */
export function Particles({ count, reducedMotion }: Props) {
  const pointsRef = useRef<THREE.Points>(null);

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const radius = 1.6 + Math.random() * 1.4;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi) * 0.5;
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [count]);

  useFrame((_state, delta) => {
    if (!reducedMotion && pointsRef.current) {
      pointsRef.current.rotation.y += delta * 0.02;
    }
  });

  if (count <= 0) return null;

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial color={colors.secondary} size={0.02} transparent opacity={0.35} sizeAttenuation />
    </points>
  );
}
