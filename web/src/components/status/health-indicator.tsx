import { useChatStore } from "@/stores/chat-store";
import { cn } from "@/lib/utils";

export function HealthIndicator() {
  const isConnected = useChatStore((s) => s.isConnected);
  const health = useChatStore((s) => s.health);

  const hasConfiguredProvider = health?.providers.some(
    (p) => p.configured && p.provider !== "local",
  );

  const status: "connected" | "degraded" | "disconnected" = !isConnected
    ? "disconnected"
    : hasConfiguredProvider
      ? "connected"
      : "degraded";

  const colors = {
    connected: "bg-success",
    degraded: "bg-warning",
    disconnected: "bg-destructive",
  };

  const glows = {
    connected: "shadow-success/40",
    degraded: "shadow-warning/40",
    disconnected: "shadow-destructive/40",
  };

  const labels = {
    connected: "Connected",
    degraded: "Local only",
    disconnected: "Disconnected",
  };

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" title={labels[status]}>
      <span className="relative flex h-2.5 w-2.5">
        {status !== "disconnected" && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-40",
              colors[status],
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex h-2.5 w-2.5 rounded-full shadow-sm",
            colors[status],
            glows[status],
          )}
        />
      </span>
      <span className="hidden sm:inline text-[11px]">{labels[status]}</span>
    </div>
  );
}
