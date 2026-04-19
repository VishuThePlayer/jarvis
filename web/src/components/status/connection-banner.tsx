import { WifiOff, RefreshCw } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";

export function ConnectionBanner() {
  const isConnected = useChatStore((s) => s.isConnected);
  const checkHealth = useChatStore((s) => s.checkHealth);

  if (isConnected) return null;

  return (
    <div className="animate-slide-in-top flex items-center justify-center gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      <WifiOff className="h-4 w-4" />
      <span>Backend disconnected</span>
      <button
        onClick={checkHealth}
        className="flex items-center gap-1.5 rounded-md bg-destructive/20 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-destructive/30"
      >
        <RefreshCw className="h-3 w-3" />
        Retry
      </button>
    </div>
  );
}
