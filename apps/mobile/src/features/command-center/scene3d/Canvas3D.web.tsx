import React from "react";
import { Canvas } from "@react-three/fiber";
import { Scene } from "./Scene";
import { CameraController } from "./CameraController";
import type { CameraState } from "./cameraState";

interface Props {
  cameraStateRef: React.MutableRefObject<CameraState>;
  particleCount: number;
  paused: boolean;
}

/**
 * Web build of the 3D canvas — standard DOM `@react-three/fiber`, real
 * browser WebGL. `frameloop="never"` while `paused` stops the render loop
 * entirely (tab backgrounded) rather than just hiding output, per "no
 * unnecessary continuous rendering."
 */
export function Canvas3D({ cameraStateRef, particleCount, paused }: Props) {
  return (
    <Canvas
      camera={{ position: [3, 2, 3], fov: 50 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: "transparent" }}
      frameloop={paused ? "never" : "always"}
    >
      <Scene particleCount={particleCount} />
      <CameraController cameraStateRef={cameraStateRef} />
    </Canvas>
  );
}
