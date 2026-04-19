import { Zap } from "lucide-react";
import type { TokenUsage } from "@/types/api";
import { formatTokenCount } from "@/lib/utils";

interface TokenUsageBadgeProps {
  usage: TokenUsage;
}

export function TokenUsageBadge({ usage }: TokenUsageBadgeProps) {
  const parts: string[] = [];
  if (usage.inputTokens != null)
    parts.push(`In: ${formatTokenCount(usage.inputTokens)}`);
  if (usage.outputTokens != null)
    parts.push(`Out: ${formatTokenCount(usage.outputTokens)}`);
  if (usage.totalTokens != null && !usage.inputTokens && !usage.outputTokens)
    parts.push(`Total: ${formatTokenCount(usage.totalTokens)}`);

  if (parts.length === 0) return null;

  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
      <Zap className="h-3 w-3" />
      <span className="tabular-nums">{parts.join(" · ")}</span>
    </div>
  );
}
