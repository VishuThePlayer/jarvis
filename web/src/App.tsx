import { useEffect } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useHealthPoll } from "@/hooks/use-health-poll";
import { AppLayout } from "@/components/layout/app-layout";

export default function App() {
  const loadModels = useChatStore((s) => s.loadModels);
  const isConnected = useChatStore((s) => s.isConnected);

  useHealthPoll();

  useEffect(() => {
    if (isConnected) {
      loadModels();
    }
  }, [isConnected, loadModels]);

  return <AppLayout />;
}
