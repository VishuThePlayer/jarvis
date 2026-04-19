import { MessageCircle, ArrowDown, Sparkles, Globe, Clock, Zap } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { MessageBubble } from "./message-bubble";
import { TypingIndicator } from "./typing-indicator";
import { cn } from "@/lib/utils";

const suggestions = [
  {
    icon: Clock,
    label: "What time is it?",
    prompt: "What time is it?",
    description: "Check the current time",
    color: "from-blue-500/20 to-cyan-500/10",
  },
  {
    icon: Globe,
    label: "Search the web",
    prompt: "Search the web for the latest tech news",
    description: "Find recent information online",
    color: "from-emerald-500/20 to-green-500/10",
  },
  {
    icon: Sparkles,
    label: "Tell me something cool",
    prompt: "Tell me an interesting fact I probably don't know",
    description: "Discover something new",
    color: "from-purple-500/20 to-pink-500/10",
  },
  {
    icon: Zap,
    label: "What can you do?",
    prompt: "What are your capabilities? What tools do you have access to?",
    description: "Explore my abilities",
    color: "from-amber-500/20 to-orange-500/10",
  },
];

export function MessageArea() {
  const messages = useChatStore((s) => s.messages);
  const responseMeta = useChatStore((s) => s.responseMeta);
  const isLoading = useChatStore((s) => s.isLoading);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const error = useChatStore((s) => s.error);
  const clearError = useChatStore((s) => s.clearError);
  const sendMessage = useChatStore((s) => s.sendMessage);

  const { ref: scrollRef, isAtBottom, scrollToBottom } = useAutoScroll<HTMLDivElement>(
    messages.length + (isLoading ? 1 : 0),
  );

  const lastMessageIndex = messages.length - 1;

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center overflow-hidden">
        {/* Background effects */}
        <div className="absolute inset-0 bg-dot-pattern opacity-30" />
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[400px] rounded-full bg-primary/5 blur-[100px] animate-float-slow" />
        <div className="absolute bottom-1/4 right-1/4 h-[250px] w-[250px] rounded-full bg-purple-500/5 blur-[80px] animate-float" />

        {/* Hero icon */}
        <div className="relative z-10">
          <div className="absolute -inset-8 rounded-full bg-gradient-to-br from-primary/15 via-purple-500/10 to-transparent blur-3xl animate-float" />
          <div className="relative flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-primary/20 via-primary/10 to-purple-500/5 border border-primary/15 shadow-2xl shadow-primary/10">
            <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-primary/10 to-transparent animate-gradient" />
            <MessageCircle className="relative h-12 w-12 text-primary drop-shadow-lg" />
          </div>
        </div>

        {/* Hero text */}
        <div className="relative z-10">
          <h2 className="text-3xl font-bold tracking-tight text-gradient-primary">
            How can I help?
          </h2>
          <p className="mt-3 text-sm text-muted-foreground/80 max-w-md leading-relaxed">
            I can search the web, run tools, remember conversations, and much more. What would you like to explore?
          </p>
        </div>

        {/* Suggestion cards */}
        <div className="relative z-10 grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2 max-w-lg w-full">
          {suggestions.map((s, i) => (
            <button
              key={s.label}
              onClick={() => sendMessage(s.prompt)}
              className="group relative flex items-start gap-3 rounded-2xl border border-border/40 bg-card/40 px-4 py-3.5 text-left transition-all duration-300 hover:border-primary/30 hover:bg-card/70 hover:shadow-lg hover:shadow-primary/5 hover:scale-[1.02]"
              style={{ animationDelay: `${i * 75}ms` }}
            >
              <div className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br transition-all duration-300 group-hover:scale-110",
                s.color,
              )}>
                <s.icon className="h-4.5 w-4.5 text-foreground/70" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground/90 group-hover:text-foreground transition-colors">
                  {s.label}
                </p>
                <p className="text-xs text-muted-foreground/60 mt-0.5">
                  {s.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto py-6"
      >
        <div className="mx-auto max-w-3xl space-y-1">
          {messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              meta={responseMeta[msg.id]}
              isLast={i === lastMessageIndex}
            />
          ))}
          {isLoading && streamingContent === "" && <TypingIndicator />}
          {error && (
            <div className="animate-fade-in-scale mx-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive backdrop-blur-sm">
              <div className="flex items-center justify-between">
                <span>{error}</span>
                <button
                  onClick={clearError}
                  className="ml-2 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors hover:bg-destructive/20"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Scroll to bottom FAB */}
      <div
        className={cn(
          "absolute bottom-4 left-1/2 -translate-x-1/2 transition-all duration-300",
          isAtBottom
            ? "pointer-events-none translate-y-4 opacity-0"
            : "translate-y-0 opacity-100",
        )}
      >
        <button
          onClick={scrollToBottom}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border/50 bg-card/90 text-muted-foreground shadow-xl backdrop-blur-md transition-all duration-200 hover:bg-accent hover:text-foreground hover:scale-110 hover:shadow-primary/10"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
