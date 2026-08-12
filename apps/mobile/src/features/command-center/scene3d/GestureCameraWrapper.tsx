import React, { useEffect, useRef } from "react";
import { View, StyleSheet, Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { clampPhi, clampRadius, type CameraState } from "./cameraState";

interface Props {
  cameraStateRef: React.MutableRefObject<CameraState>;
  children: React.ReactNode;
}

const ROTATE_SENSITIVITY = 0.006;
const WHEEL_ZOOM_SENSITIVITY = 0.0025;

/**
 * Drag-to-orbit + pinch-to-zoom via `react-native-gesture-handler`, which
 * (unlike `@react-three/drei`'s OrbitControls) works identically on
 * native and web without needing a DOM `domElement` reference — the same
 * component wraps the Canvas on both platforms. Mutates `cameraStateRef`
 * directly (no React state) so dragging never re-renders the component
 * tree; CameraController.tsx (inside the Canvas) applies the result each
 * frame. Web-only: also listens for mouse wheel, since a mouse has no
 * pinch gesture.
 */
export function GestureCameraWrapper({ cameraStateRef, children }: Props) {
  const pinchStartRadius = useRef(cameraStateRef.current.radius);
  const containerRef = useRef<View>(null);
  const lastTranslation = useRef({ x: 0, y: 0 });

  const pan = Gesture.Pan()
    .onStart(() => {
      lastTranslation.current = { x: 0, y: 0 };
    })
    .onUpdate((e) => {
      const s = cameraStateRef.current;
      const dx = e.translationX - lastTranslation.current.x;
      const dy = e.translationY - lastTranslation.current.y;
      lastTranslation.current = { x: e.translationX, y: e.translationY };
      s.theta -= dx * ROTATE_SENSITIVITY;
      s.phi = clampPhi(s.phi - dy * ROTATE_SENSITIVITY);
    });

  const pinch = Gesture.Pinch()
    .onStart(() => {
      pinchStartRadius.current = cameraStateRef.current.radius;
    })
    .onUpdate((e) => {
      cameraStateRef.current.radius = clampRadius(pinchStartRadius.current / e.scale);
    });

  const gesture = Gesture.Simultaneous(pan, pinch);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraStateRef.current.radius = clampRadius(cameraStateRef.current.radius + e.deltaY * WHEEL_ZOOM_SENSITIVITY);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [cameraStateRef]);

  return (
    <GestureDetector gesture={gesture}>
      <View ref={containerRef} style={styles.container}>
        {children}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
