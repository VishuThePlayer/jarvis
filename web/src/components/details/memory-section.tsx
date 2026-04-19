import { useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import type { MemoryEntry } from "@/types/api";
import { cn } from "@/lib/utils";

interface MemorySectionProps {
  memories: MemoryEntry[];
}

const kindColors: Record<string, string> = {
  fact: "bg-blue-500/15 text-blue-400 ring-blue-500/20",
  preference: "bg-purple-500/15 text-purple-400 ring-purple-500/20",
  episode: "bg-amber-500/15 text-amber-400 ring-amber-500/20",
  summary: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/20",
};

export function MemorySection({ memories }: MemorySectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (memories.length === 0) return null;

  return (
    <div className="mt-2 rounded-xl border border-border/40 bg-secondary/20 backdrop-blur-sm">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="h-3.5 w-3.5 text-purple-400/60" />
        <span className="font-medium">
          {memories.length} {memories.length === 1 ? "memory" : "memories"}{" "}
          stored
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </button>
      {isOpen && (
        <div className="animate-fade-in border-t border-border/30 px-3 py-2 space-y-1.5">
          {memories.map((mem) => (
            <div
              key={mem.id}
              className="flex items-start gap-2 rounded-lg border border-border/30 bg-background/40 px-3 py-2 text-xs"
            >
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1",
                  kindColors[mem.kind] ?? "bg-muted text-muted-foreground ring-border",
                )}
              >
                {mem.kind}
              </span>
              <span className="text-foreground/90 leading-relaxed">
                {mem.content}
              </span>
              <span className="ml-auto shrink-0 text-muted-foreground/50 tabular-nums">
                {Math.round(mem.confidence * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
