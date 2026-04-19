import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import type { ConversationRecord } from "@/types/api";
import { cn, formatRelativeTime } from "@/lib/utils";

interface ConversationItemProps {
  conversation: ConversationRecord;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

export function ConversationItem({
  conversation,
  isActive,
  onClick,
  onDelete,
  onRename,
}: ConversationItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(conversation.title);
    setIsEditing(true);
  };

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== conversation.title) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setIsEditing(false);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  return (
    <button
      onClick={onClick}
      onDoubleClick={handleDoubleClick}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all duration-200",
        isActive
          ? "bg-primary/10 text-accent-foreground shadow-sm"
          : "text-sidebar-foreground/80 hover:bg-accent/30 hover:text-sidebar-foreground",
      )}
    >
      {isActive && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-primary shadow-sm shadow-primary/50" />
      )}
      <MessageSquare className={cn(
        "h-4 w-4 shrink-0 transition-colors",
        isActive ? "text-primary" : "text-muted-foreground/40",
      )} />
      <div className="min-w-0 flex-1">
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-transparent text-sm font-medium outline-none border-b border-primary/50"
          />
        ) : (
          <p className="truncate text-[13px] font-medium">{conversation.title}</p>
        )}
        <p className="text-[10px] text-muted-foreground/40 mt-0.5">
          {formatRelativeTime(conversation.updatedAt)}
        </p>
      </div>
      {!isEditing && (
        <button
          onClick={handleDelete}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground/30 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="Delete conversation"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </button>
  );
}
