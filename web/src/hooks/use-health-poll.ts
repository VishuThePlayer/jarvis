import { useEffect } from "react";
import { useChatStore } from "@/stores/chat-store";

export function useHealthPoll(intervalMs = 30_000) {
  const checkHealth = useChatStore((s) => s.checkHealth);

  useEffect(() => {
    checkHealth();
    const id = setInterval(checkHealth, intervalMs);
    return () => clearInterval(id);
  }, [checkHealth, intervalMs]);
}
