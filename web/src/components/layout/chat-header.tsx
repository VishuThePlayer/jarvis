import { Menu, PanelLeftClose } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { ModelSelector } from "@/components/controls/model-selector";
import { WebSearchToggle } from "@/components/controls/web-search-toggle";
import { useMobile } from "@/hooks/use-mobile";

export function ChatHeader() {
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const isSidebarOpen = useChatStore((s) => s.isSidebarOpen);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversations = useChatStore((s) => s.conversations);
  const isMobile = useMobile();

  const title = activeConversationId
    ? conversations[activeConversationId]?.title ?? "Conversation"
    : "New conversation";

  return (
    <header className="relative flex items-center justify-between bg-background/80 backdrop-blur-xl px-4 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={toggleSidebar}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/60 hover:bg-accent hover:text-foreground transition-all duration-200"
          title={isSidebarOpen ? "Close sidebar (Ctrl+Shift+S)" : "Open sidebar (Ctrl+Shift+S)"}
        >
          {isMobile ? (
            <Menu className="h-5 w-5" />
          ) : (
            <PanelLeftClose className={`h-4.5 w-4.5 transition-transform duration-200 ${!isSidebarOpen ? "rotate-180" : ""}`} />
          )}
        </button>
        <h1 className="truncate text-sm font-medium text-foreground/80">
          {title}
        </h1>
      </div>

      <div className="flex items-center gap-2">
        <WebSearchToggle />
        <ModelSelector />
      </div>

      {/* Bottom fade line */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-border/60 to-transparent" />
    </header>
  );
}
