/**
 * NVIDIA-inspired dark theme (docs/architecture/00-overview.md — visual
 * direction: graphite/black base, restrained green accent, subtle
 * cyan/blue secondary glow, technical and premium, not gaming RGB).
 */
export const colors = {
  // NVIDIA's own dark surfaces are a true dark gray (#1a1a1a), not
  // nearer-black — the old #0a0d0c read as pure black, which their own
  // guidelines call out as the wrong reference tone.
  bgBase: "#1a1a1a",
  bgSurface: "#222322",
  bgSurfaceRaised: "#282a28",
  bgGlass: "rgba(34, 35, 34, 0.72)",
  border: "#333734",
  borderStrong: "#3f453f34",

  textPrimary: "#eef2ee",
  textSecondary: "#9aa69f",
  textTertiary: "#647069",

  accent: "#76b900", // NVIDIA's actual trademark green (PMS 376C / RGB 118,185,0) — used sparingly, not as a background flood
  accentDim: "#4d7800",
  accentGlow: "rgba(118, 185, 0, 0.14)",

  secondary: "#3ec6ff", // cyan/blue secondary glow — routing/model info, not primary actions
  secondaryGlow: "rgba(62, 198, 255, 0.12)",

  success: "#4fd67a",
  warning: "#e8b339",
  danger: "#ff5c5c",
  dangerGlow: "rgba(255, 92, 92, 0.12)",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  mono: "SpaceMono-Regular",
  fontSize: {
    xs: 12,
    sm: 13,
    md: 15,
    lg: 18,
    xl: 22,
    xxl: 28,
  },
  /** M6: wider tracking on labels/headings is most of what reads as "premium technical UI" rather than "default app" — used sparingly, on uppercase eyebrow/section labels only. */
  letterSpacingWide: 0.6,
} as const;

/** M6: one shared elevation preset for every "glass panel" card (Command Center, Agent/Model/Memory/Tools Centers) — consistent depth instead of each screen inventing its own shadow values. React Native's shadow* props are iOS-only and elevation is Android-only; both are set so the look is consistent if this ever runs on iOS too. */
export const elevation = {
  panel: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
} as const;

/** M6: shared animation timings — kept short/subtle per instruction ("performant on mid-range Android devices"), using React Native's built-in Animated API only (no new native animation dependency). */
export const motion = {
  fast: 140,
  base: 220,
  slow: 360,
  /** Pulse-cycle duration for live/active status indicators (AgentNetwork, PulseDot). */
  pulseCycle: 1400,
} as const;

export type StatusColor = "idle" | "connected" | "error" | "working";

export function statusColor(status: StatusColor): string {
  switch (status) {
    case "connected":
      return colors.success;
    case "error":
      return colors.danger;
    case "working":
      return colors.secondary;
    case "idle":
    default:
      return colors.textTertiary;
  }
}

/** M6: maps an event's severity (docs/architecture/05-event-schemas.md) to a display color, for the Live Event Stream and any other raw-event rendering. */
export function severityColor(severity: "debug" | "info" | "warn" | "error"): string {
  switch (severity) {
    case "error":
      return colors.danger;
    case "warn":
      return colors.warning;
    case "info":
      return colors.secondary;
    case "debug":
    default:
      return colors.textTertiary;
  }
}
