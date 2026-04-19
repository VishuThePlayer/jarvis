import { Bot } from "lucide-react";

export function TypingIndicator() {
  return (
    <div className="message-enter flex items-start gap-3 px-4 py-2">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 ring-1 ring-primary/10">
        <Bot className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="flex items-center gap-2.5 rounded-2xl bg-card/60 border border-border/30 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-1.5">
          <div className="typing-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
          <div className="typing-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
          <div className="typing-dot h-1.5 w-1.5 rounded-full bg-primary/70" />
        </div>
        <span className="text-xs text-muted-foreground/50">Thinking</span>
      </div>
    </div>
  );
}
