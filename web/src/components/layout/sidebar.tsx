import { useState } from "react";
import { Plus, Bot, Search } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { ConversationList } from "@/components/conversation/conversation-list";
import { HealthIndicator } from "@/components/status/health-indicator";

export function Sidebar() {
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const health = useChatStore((s) => s.health);
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-sidebar via-sidebar to-sidebar/90 border-r border-sidebar-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/25 via-primary/15 to-purple-500/10 shadow-lg shadow-primary/10">
            <Bot className="relative h-5 w-5 text-primary" />
          </div>
          <div>
            <span className="text-sm font-bold text-sidebar-foreground tracking-tight">
              Jarvis
            </span>
            <span className="block text-[10px] text-muted-foreground/50 font-medium">
              AI Assistant
            </span>
          </div>
        </div>
        <button
          onClick={startNewConversation}
          className="flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground/60 hover:bg-primary/10 hover:text-primary transition-all duration-200 hover:scale-105 hover:shadow-sm"
          title="New conversation (Ctrl+N)"
        >
          <Plus className="h-4.5 w-4.5" />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
          <input
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-sidebar-border/60 bg-sidebar/50 py-2 pl-9 pr-3 text-xs text-sidebar-foreground placeholder:text-muted-foreground/30 outline-none transition-all duration-200 focus:border-primary/30 focus:bg-sidebar/80"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto py-1">
        <ConversationList searchQuery={searchQuery} />
      </div>

      {/* Footer */}
      <div className="border-t border-sidebar-border/60 px-4 py-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <HealthIndicator />
          {health && (
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30">
              {health.persistenceDriver}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
