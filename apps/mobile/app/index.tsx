import { Redirect } from "expo-router";
import { useSessionStore } from "../src/state/sessionStore";

export default function Index() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return <Redirect href={accessToken ? "/(command-center)" : "/(auth)/pairing"} />;
}
