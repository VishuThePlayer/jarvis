import { Globe } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { cn } from "@/lib/utils";

export function WebSearchToggle() {
  const allowWebSearch = useChatStore((s) => s.allowWebSearch);
  const preferWebSearch = useChatStore((s) => s.preferWebSearch);
  const setWebSearch = useChatStore((s) => s.setWebSearch);

  const handleClick = () => {
    if (!allowWebSearch) {
      setWebSearch(true, false);
    } else if (!preferWebSearch) {
      setWebSearch(true, true);
    } else {
      setWebSearch(false, false);
    }
  };

  const label = preferWebSearch
    ? "Prefer"
    : allowWebSearch
      ? "On"
      : "Off";

  return (
    <button
      onClick={handleClick}
      title={`Web search: ${label}. Click to cycle.`}
      className={cn(
        "flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs transition-all duration-200",
        allowWebSearch
          ? preferWebSearch
            ? "border-primary/40 bg-primary/10 text-primary shadow-sm shadow-primary/5"
            : "border-primary/25 bg-primary/5 text-primary/80"
          : "border-border/40 text-muted-foreground/50 hover:text-muted-foreground hover:border-border/60",
      )}
    >
      <Globe className={cn(
        "h-3.5 w-3.5 transition-colors",
        allowWebSearch && "text-primary",
      )} />
      <span className="hidden sm:inline font-medium">{label}</span>
    </button>
  );
}
