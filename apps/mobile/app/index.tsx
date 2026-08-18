import { Redirect } from "expo-router";

// _layout.tsx blocks rendering the Stack (below index.tsx) until it has
// either hydrated a stored session or silently auto-paired a new one — so
// by the time this route ever mounts, a session is guaranteed to exist.
export default function Index() {
  return <Redirect href="/(command-center)" />;
}
