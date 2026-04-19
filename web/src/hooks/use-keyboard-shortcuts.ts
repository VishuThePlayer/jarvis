import { useEffect } from "react";
import { useChatStore } from "@/stores/chat-store";

export function useKeyboardShortcuts() {
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const abortRequest = useChatStore((s) => s.abortRequest);
  const isLoading = useChatStore((s) => s.isLoading);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "n") {
        e.preventDefault();
        startNewConversation();
      }

      if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        toggleSidebar();
      }

      if (e.key === "Escape" && isLoading) {
        abortRequest();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [startNewConversation, toggleSidebar, abortRequest, isLoading]);
}
