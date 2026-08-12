import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CAMERA_DEFAULT } from "./constants";
import type { CameraState } from "./cameraState";

interface Props {
  cameraStateRef: React.MutableRefObject<CameraState>;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Applies `cameraStateRef`'s spherical coordinates to the r3f camera every frame, and eases toward the default view when a reset was requested (Reset Camera button). */
export function CameraController({ cameraStateRef }: Props) {
  const { camera } = useThree();
  const resetProgress = useRef(0);

  useFrame(() => {
    const s = cameraStateRef.current;

    if (s.resetRequested) {
      resetProgress.current = Math.min(1, resetProgress.current + 0.06);
      s.theta = lerp(s.theta, CAMERA_DEFAULT.theta, 0.12);
      s.phi = lerp(s.phi, CAMERA_DEFAULT.phi, 0.12);
      s.radius = lerp(s.radius, CAMERA_DEFAULT.radius, 0.12);
      if (resetProgress.current >= 1) {
        s.theta = CAMERA_DEFAULT.theta;
        s.phi = CAMERA_DEFAULT.phi;
        s.radius = CAMERA_DEFAULT.radius;
        s.resetRequested = false;
        resetProgress.current = 0;
      }
    }

    camera.position.set(
      s.radius * Math.sin(s.phi) * Math.cos(s.theta),
      s.radius * Math.cos(s.phi),
      s.radius * Math.sin(s.phi) * Math.sin(s.theta),
    );
    camera.lookAt(0, 0, 0);
  });

  return null;
}
