import React, { useRef } from "react";
import type * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { colors } from "../../../theme/tokens";
import type { MasterPulse } from "./sceneTypes";

interface Props {
  active: boolean;
  pulse: MasterPulse;
  reducedMotion: boolean;
}

const CORE_COLOR = colors.accent;
const PULSE_COLOR = colors.secondary;

/**
 * The central Master Core — a glass-like icosahedron with two slowly
 * spinning rings, standing in for "orchestration." `active` reflects the
 * real chatStore connection state (a task actually in flight); `pulse`
 * fires only on a real task.completed/memory.retrieved event. Idle means
 * a slow, steady breathing glow — never fully static (reads as "alive")
 * but never a flashy animation either.
 */
export function MasterCore({ active, pulse, reducedMotion }: Props) {
  const coreRef = useRef<THREE.Mesh>(null);
  const ringARef = useRef<THREE.Mesh>(null);
  const ringBRef = useRef<THREE.Mesh>(null);
  const flashElapsed = useRef(0);

  useFrame((_state, delta) => {
    if (!reducedMotion) {
      if (ringARef.current) ringARef.current.rotation.y += delta * 0.25;
      if (ringBRef.current) ringBRef.current.rotation.x += delta * 0.18;
    }

    const t = performance.now() / 1000;
    const breathe = 1 + Math.sin(t * (active ? 2.2 : 0.8)) * (active ? 0.06 : 0.03);

    if (pulse !== "none") {
      flashElapsed.current += delta;
      const burst = Math.max(0, 1 - flashElapsed.current / 1.2);
      if (coreRef.current) coreRef.current.scale.setScalar(breathe + burst * 0.35);
    } else {
      flashElapsed.current = 0;
      if (coreRef.current) coreRef.current.scale.setScalar(breathe);
    }
  });

  const color = pulse === "memory" ? PULSE_COLOR : CORE_COLOR;

  return (
    <group>
      <mesh ref={coreRef}>
        <icosahedronGeometry args={[0.55, 2]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={active ? 0.9 : 0.4}
          roughness={0.25}
          metalness={0.1}
          transparent
          opacity={0.85}
        />
      </mesh>
      <mesh ref={ringARef} rotation={[Math.PI / 3, 0, 0]}>
        <torusGeometry args={[0.85, 0.015, 8, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} />
      </mesh>
      <mesh ref={ringBRef} rotation={[0, 0, Math.PI / 4]}>
        <torusGeometry args={[1.05, 0.01, 8, 64]} />
        <meshBasicMaterial color={colors.secondary} transparent opacity={0.35} />
      </mesh>
      <pointLight color={color} intensity={active ? 2.2 : 1} distance={4} />
    </group>
  );
}
