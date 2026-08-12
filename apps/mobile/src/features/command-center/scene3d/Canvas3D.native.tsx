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
 * Native (Android) build of the 3D canvas. Metro resolves the bare
 * "@react-three/fiber" import to this package's own `react-native` build
 * (backed by `expo-gl`) automatically on this platform — same import
 * specifier as Canvas3D.web.tsx, different runtime, no manual subpath
 * needed. Requires a Development Build (expo-gl is native code, not
 * available in Expo Go — docs/architecture/10-android-setup.md §4).
 * `frameloop="never"` while `paused` (app backgrounded) stops rendering
 * without tearing down the GL context.
 */
export function Canvas3D({ cameraStateRef, particleCount, paused }: Props) {
  return (
    <Canvas camera={{ position: [3, 2, 3], fov: 50 }} gl={{ antialias: true }} frameloop={paused ? "never" : "always"}>
      <Scene particleCount={particleCount} />
      <CameraController cameraStateRef={cameraStateRef} />
    </Canvas>
  );
}
