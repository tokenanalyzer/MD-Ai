import { CAMERA_DEFAULT, CAMERA_MAX_PHI, CAMERA_MAX_RADIUS, CAMERA_MIN_PHI, CAMERA_MIN_RADIUS } from "./constants";

/**
 * Spherical camera coordinates shared between the gesture layer (outside
 * the Canvas — GestureCameraWrapper.tsx) and the render layer (inside the
 * Canvas — CameraController.tsx) via a plain mutable object, not React
 * state: gestures fire many times a second and re-rendering the whole
 * component tree on every pan/pinch tick would defeat the point of
 * keeping this scene cheap. `resetRequested` is a one-shot flag
 * CameraController consumes and clears.
 */
export interface CameraState {
  theta: number;
  phi: number;
  radius: number;
  resetRequested: boolean;
}

export function createCameraState(): CameraState {
  return { ...CAMERA_DEFAULT, resetRequested: false };
}

export function clampPhi(phi: number): number {
  return Math.min(CAMERA_MAX_PHI, Math.max(CAMERA_MIN_PHI, phi));
}

export function clampRadius(radius: number): number {
  return Math.min(CAMERA_MAX_RADIUS, Math.max(CAMERA_MIN_RADIUS, radius));
}
