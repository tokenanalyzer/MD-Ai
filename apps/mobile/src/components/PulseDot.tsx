import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import { colors, motion } from "../theme/tokens";

interface Props {
  color?: string;
  size?: number;
  /** Only animates when true — an idle/disabled agent shows a static dot, not a pulse, per "no fake activity." */
  active?: boolean;
}

/**
 * M6's "agent activity pulse" — a soft breathing-glow animation using
 * React Native's built-in `Animated` API (no new animation dependency).
 * Deliberately opt-in via `active`: a pulsing dot claims "this is doing
 * something right now," so it must reflect a real state (agent
 * status === "working", a live event just arrived), never decorative
 * motion applied unconditionally.
 */
export function PulseDot({ color = colors.accent, size = 10, active = false }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (!active) {
      scale.setValue(1);
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale, { toValue: 1.8, duration: motion.pulseCycle / 2, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0, duration: motion.pulseCycle / 2, useNativeDriver: true }),
        ]),
        Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.6, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, scale, opacity]);

  return (
    <Animated.View style={{ width: size, height: size }}>
      <Animated.View
        style={[
          styles.ring,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity, transform: [{ scale }] },
        ]}
      />
      <Animated.View style={[styles.core, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ring: { position: "absolute" },
  core: { position: "absolute" },
});
