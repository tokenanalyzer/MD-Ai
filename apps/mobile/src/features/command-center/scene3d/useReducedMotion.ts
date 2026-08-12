import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/**
 * Respects the OS-level "reduce motion" accessibility setting
 * (`AccessibilityInfo.isReduceMotionEnabled` — a built-in React Native
 * API, no new dependency) on native, and `prefers-reduced-motion` on web.
 * When true, the 3D scene stops continuous orbital rotation/particle
 * drift; activity pulses (which convey real state, not decoration) still
 * play.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") {
      const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
      if (!mq) return;
      setReduced(mq.matches);
      const listener = (e: MediaQueryListEvent) => setReduced(e.matches);
      mq.addEventListener?.("change", listener);
      return () => mq.removeEventListener?.("change", listener);
    }

    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!cancelled) setReduced(value);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return reduced;
}
