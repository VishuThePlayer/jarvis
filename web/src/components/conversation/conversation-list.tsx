import { useChatStore } from "@/stores/chat-store";
import { ConversationItem } from "./conversation-item";

interface ConversationListProps {
  searchQuery?: string;
}

export function ConversationList({ searchQuery = "" }: ConversationListProps) {
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);

  const sorted = Object.values(conversations)
    .filter((c) =>
      searchQuery
        ? c.title.toLowerCase().includes(searchQuery.toLowerCase())
        : true,
    )
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

  if (sorted.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground/40">
        {searchQuery ? "No matches found" : "No conversations yet"}
      </div>
    );
  }

  return (
    <div className="space-y-0.5 px-2">
      {sorted.map((conv) => (
        <ConversationItem
          key={conv.id}
          conversation={conv}
          isActive={conv.id === activeConversationId}
          onClick={() => selectConversation(conv.id)}
          onDelete={() => deleteConversation(conv.id)}
          onRename={(title) => renameConversation(conv.id, title)}
        />
      ))}
    </div>
  );
}
