import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { cn } from "@/lib/utils";

export function ChatInput() {
  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortRequest = useChatStore((s) => s.abortRequest);
  const isLoading = useChatStore((s) => s.isLoading);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [isLoading]);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    sendMessage(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = value.trim().length > 0;

  return (
    <div className="bg-gradient-to-t from-background via-background to-background/80 px-4 pb-4 pt-2">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            "relative flex items-end gap-2 rounded-2xl border bg-card/60 backdrop-blur-md transition-all duration-300",
            isFocused
              ? "border-primary/40 shadow-[0_0_0_3px_oklch(0.68_0.19_270/0.08)] shadow-primary/5"
              : "border-border/50 hover:border-border/80",
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Message Jarvis..."
            disabled={isLoading}
            rows={1}
            className={cn(
              "flex-1 resize-none bg-transparent py-3.5 pl-4 pr-2",
              "text-sm text-foreground placeholder:text-muted-foreground/50",
              "outline-none",
              "disabled:opacity-50",
            )}
          />
          <div className="flex items-center gap-1.5 pr-2 pb-2">
            <button
              onClick={isLoading ? abortRequest : handleSend}
              disabled={!isLoading && !canSend}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all duration-200",
                isLoading
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:scale-105"
                  : canSend
                    ? "bg-primary text-primary-foreground shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/30 hover:scale-105 hover:brightness-110"
                    : "bg-muted/50 text-muted-foreground/40 cursor-not-allowed",
              )}
            >
              {isLoading ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <ArrowUp className="h-4.5 w-4.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
