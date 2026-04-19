import { useState } from "react";
import { Copy, Check, RotateCcw, Bot } from "lucide-react";
import type { MessageRecord, ResponseMeta } from "@/types/api";
import { MarkdownContent } from "./markdown-content";
import { ToolCallSection } from "@/components/details/tool-call-section";
import { MemorySection } from "@/components/details/memory-section";
import { TokenUsageBadge } from "@/components/details/token-usage-badge";
import { useChatStore } from "@/stores/chat-store";
import { cn, formatRelativeTime } from "@/lib/utils";

interface MessageBubbleProps {
  message: MessageRecord;
  meta?: ResponseMeta;
  isLast?: boolean;
}

export function MessageBubble({ message, meta, isLast }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [showTimestamp, setShowTimestamp] = useState(false);
  const retryLastMessage = useChatStore((s) => s.retryLastMessage);
  const isLoading = useChatStore((s) => s.isLoading);
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  if (message.role === "tool" || message.role === "system") return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isUser) {
    return (
      <div
        className="message-enter flex justify-end px-4 py-1.5"
        onMouseEnter={() => setShowTimestamp(true)}
        onMouseLeave={() => setShowTimestamp(false)}
      >
        <div className="max-w-[80%] sm:max-w-[70%] lg:max-w-[60%]">
          <div className="rounded-2xl rounded-br-md bg-gradient-to-br from-user-bubble to-user-bubble/85 px-4 py-2.5 shadow-md shadow-user-bubble/10">
            <p className="text-sm whitespace-pre-wrap leading-relaxed text-user-bubble-foreground">
              {message.content}
            </p>
          </div>
          <div
            className={cn(
              "mt-0.5 px-1 text-[10px] text-muted-foreground/40 text-right transition-opacity duration-200",
              showTimestamp ? "opacity-100" : "opacity-0",
            )}
          >
            {formatRelativeTime(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }

  if (isAssistant) {
    return (
      <div
        className="message-enter group px-4 py-2"
        onMouseEnter={() => setShowTimestamp(true)}
        onMouseLeave={() => setShowTimestamp(false)}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 mt-0.5 ring-1 ring-primary/10">
            <Bot className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <MarkdownContent content={message.content} />

            {/* Action toolbar */}
            <div className="flex items-center gap-0.5 mt-1.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              <button
                onClick={handleCopy}
                className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted-foreground/60 transition-colors hover:text-foreground hover:bg-accent/50"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 text-success" />
                    <span className="text-success">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
              {isLast && !isLoading && (
                <button
                  onClick={retryLastMessage}
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted-foreground/60 transition-colors hover:text-foreground hover:bg-accent/50"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Retry</span>
                </button>
              )}
              <div
                className={cn(
                  "ml-2 text-[10px] text-muted-foreground/30 transition-opacity duration-200",
                  showTimestamp ? "opacity-100" : "opacity-0",
                )}
              >
                {formatRelativeTime(message.createdAt)}
              </div>
            </div>

            {meta && (
              <div className="mt-2 space-y-1.5 max-w-[90%]">
                <ToolCallSection toolCalls={meta.toolCalls} />
                <MemorySection memories={meta.memoryWrites} />
                {meta.usage && <TokenUsageBadge usage={meta.usage} />}
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/40">
                  <span className="rounded-full bg-secondary/40 px-2 py-0.5 font-mono">
                    {meta.providerUsed}:{meta.modelUsed}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
