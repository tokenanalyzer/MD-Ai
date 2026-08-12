import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, AppState } from "react-native";
import { colors, radius, spacing, typography } from "../../../theme/tokens";
import { ErrorBoundary3D } from "./ErrorBoundary3D";
import { GestureCameraWrapper } from "./GestureCameraWrapper";
import { createCameraState } from "./cameraState";
import { useParticleBudget } from "./useParticleBudget";

// Lazy + dynamic import: if the platform build of Canvas3D fails to even
// load (e.g. expo-gl not linked into this build), React treats the
// rejected import() as a thrown error during render, caught by
// ErrorBoundary3D below exactly like a runtime GL error would be. A
// static top-level `import` could not be guarded this way.
const Canvas3DLazy = lazy(() => import("./Canvas3D").then((m) => ({ default: m.Canvas3D })));

/**
 * M7 3D Command Center — public entry point. Mounted as an ADDITIONAL
 * panel inside (command-center)/index.tsx, never a replacement for the 2D
 * AgentNetwork panel, which stays on screen unconditionally right below
 * it. If this component fails to load or render for any reason, it
 * renders nothing (`unavailable`) and the rest of the M6 2D Command
 * Center — already fully functional — is exactly what the user sees.
 * That is the "automatic, graceful fallback" the milestone requires: no
 * separate fallback UI to build, because the working 2D UI never left.
 */
export function CommandCenter3D() {
  const [unavailable, setUnavailable] = useState(false);
  const [appActive, setAppActive] = useState(true);
  const cameraStateRef = useRef(createCameraState());
  const particleCount = useParticleBudget();

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setAppActive(state === "active"));
    return () => sub.remove();
  }, []);

  const handleError = useCallback((err: Error) => {
    if (__DEV__) console.warn("[CommandCenter3D] 3D unavailable, falling back to 2D view:", err.message);
    setUnavailable(true);
  }, []);

  if (unavailable) return null;

  return (
    <View style={styles.wrap}>
      {/* Decorative — the real accessible status lives in the sibling AICoreCard/AgentNetwork/LiveEventStream/CurrentTask panels, so this region is hidden from screen readers rather than described. */}
      <View style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <ErrorBoundary3D onError={handleError}>
          <Suspense fallback={<View style={styles.loading} />}>
            <GestureCameraWrapper cameraStateRef={cameraStateRef}>
              <Canvas3DLazy cameraStateRef={cameraStateRef} particleCount={particleCount} paused={!appActive} />
            </GestureCameraWrapper>
          </Suspense>
        </ErrorBoundary3D>
      </View>
      <Pressable
        style={styles.resetButton}
        onPress={() => {
          cameraStateRef.current.resetRequested = true;
        }}
        accessibilityRole="button"
        accessibilityLabel="Reset camera view"
      >
        <Text style={styles.resetButtonText}>Reset View</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 280, borderRadius: radius.lg, overflow: "hidden", backgroundColor: colors.bgSurface, borderWidth: 1, borderColor: colors.border },
  loading: { flex: 1 },
  resetButton: {
    position: "absolute",
    right: spacing.sm,
    bottom: spacing.sm,
    backgroundColor: colors.bgGlass,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  resetButtonText: { color: colors.secondary, fontSize: typography.fontSize.xs, fontWeight: "600" },
});
