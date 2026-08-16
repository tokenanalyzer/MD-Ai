import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing } from "../theme/tokens";

/**
 * Every screen renders its own header (`headerShown: false` on the root
 * Stack, see app/_layout.tsx) with a fixed `paddingTop: spacing.xl`
 * instead of accounting for the device's actual status bar / notch
 * inset — on a real phone that pushes the header text up under the
 * status bar, clipping it. This returns the real top padding to use
 * instead.
 */
export function useScreenTopPadding(): number {
  const insets = useSafeAreaInsets();
  return insets.top + spacing.md;
}
