import { useChatStore } from "@/stores/chat-store";
import { useMobile } from "@/hooks/use-mobile";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { Sidebar } from "./sidebar";
import { ChatHeader } from "./chat-header";
import { MessageArea } from "@/components/chat/message-area";
import { ChatInput } from "@/components/chat/chat-input";
import { ConnectionBanner } from "@/components/status/connection-banner";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

export function AppLayout() {
  const isSidebarOpen = useChatStore((s) => s.isSidebarOpen);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const isMobile = useMobile();

  useKeyboardShortcuts();

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Mobile sidebar overlay */}
      {isMobile && isSidebarOpen && (
        <div className="fixed inset-0 z-40 animate-fade-in">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={toggleSidebar}
          />
          <div className="absolute inset-y-0 left-0 z-50 w-72 animate-slide-in-bottom" style={{ animation: "slide-in-left 0.25s cubic-bezier(0.16, 1, 0.3, 1)" }}>
            <Sidebar />
            <button
              onClick={toggleSidebar}
              className="absolute right-2 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Desktop sidebar with smooth transition */}
      <div
        className={cn(
          "shrink-0 overflow-hidden transition-all duration-300 ease-in-out",
          !isMobile && isSidebarOpen ? "w-72" : "w-0",
        )}
      >
        <div className="h-full w-72">
          <Sidebar />
        </div>
      </div>

      {/* Main panel */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <ConnectionBanner />
        <ChatHeader />
        <MessageArea />
        <ChatInput />
      </div>
    </div>
  );
}
