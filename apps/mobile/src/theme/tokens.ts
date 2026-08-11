/**
 * NVIDIA-inspired dark theme (docs/architecture/00-overview.md — visual
 * direction: graphite/black base, restrained green accent, subtle
 * cyan/blue secondary glow, technical and premium, not gaming RGB).
 */
export const colors = {
  bgBase: "#0a0d0c",
  bgSurface: "#121614",
  bgSurfaceRaised: "#181d1a",
  bgGlass: "rgba(22, 28, 25, 0.72)",
  border: "#232a26",
  borderStrong: "#31392f34",

  textPrimary: "#eef2ee",
  textSecondary: "#9aa69f",
  textTertiary: "#647069",

  accent: "#76ff2e", // restrained NVIDIA-inspired green — used sparingly, not as a background flood
  accentDim: "#4f8f2e",
  accentGlow: "rgba(118, 255, 46, 0.14)",

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
  },
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
