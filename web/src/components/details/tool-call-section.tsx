import { useState } from "react";
import { ChevronDown, Wrench, CheckCircle2, XCircle } from "lucide-react";
import type { ToolCallRecord } from "@/types/api";
import { cn } from "@/lib/utils";

interface ToolCallSectionProps {
  toolCalls: ToolCallRecord[];
}

export function ToolCallSection({ toolCalls }: ToolCallSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (toolCalls.length === 0) return null;

  return (
    <div className="mt-2 rounded-xl border border-border/40 bg-secondary/20 backdrop-blur-sm">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Wrench className="h-3.5 w-3.5 text-primary/50" />
        <span className="font-medium">
          {toolCalls.length} tool {toolCalls.length === 1 ? "call" : "calls"}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </button>
      {isOpen && (
        <div className="animate-fade-in border-t border-border/30 px-3 py-2 space-y-2">
          {toolCalls.map((tc) => (
            <ToolCallItem key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallItem({ toolCall }: { toolCall: ToolCallRecord }) {
  const [showOutput, setShowOutput] = useState(false);

  return (
    <div className="rounded-lg border border-border/30 bg-background/40 text-xs">
      <div className="flex items-center gap-2 px-3 py-1.5">
        {toolCall.success ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        )}
        <span className="font-mono font-medium text-foreground">
          {toolCall.name}
        </span>
        {toolCall.input && (
          <span className="truncate text-muted-foreground/70">
            {toolCall.input}
          </span>
        )}
      </div>
      {toolCall.output && (
        <>
          <button
            onClick={() => setShowOutput(!showOutput)}
            className="w-full border-t border-border/20 px-3 py-1 text-left text-muted-foreground hover:text-foreground transition-colors"
          >
            {showOutput ? "Hide output" : "Show output"}
          </button>
          {showOutput && (
            <pre className="animate-fade-in border-t border-border/20 px-3 py-2 whitespace-pre-wrap font-mono text-muted-foreground/80 leading-relaxed">
              {toolCall.output}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
