import * as Device from "expo-device";

/**
 * Caps the ambient particle count from a real device-memory signal
 * (`expo-device`'s `totalMemory`, already a dependency — M5 push
 * notifications' device registration uses the same package) rather than
 * a fixed constant, per "gracefully reduce visual complexity on weaker
 * devices." `totalMemory` is `null` when the platform can't report it
 * (some Android OEM builds, older iOS); that gets the conservative
 * middle tier, not the richest one.
 */
export function useParticleBudget(): number {
  const totalMemory = Device.totalMemory;
  if (totalMemory === null) return 25;
  const gib = totalMemory / 1024 ** 3;
  if (gib < 3) return 0;
  if (gib < 5) return 20;
  return 45;
}
