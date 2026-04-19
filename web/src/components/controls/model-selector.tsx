import { ChevronDown, Cpu } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useChatStore } from "@/stores/chat-store";
import { cn } from "@/lib/utils";
import type { ModelDescriptor, ProviderKind } from "@/types/api";

const providerLabels: Record<ProviderKind, string> = {
  local: "Local (Offline)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const providerOrder: ProviderKind[] = ["openai", "openrouter", "local"];

export function ModelSelector() {
  const models = useChatStore((s) => s.models);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectModel = useChatStore((s) => s.selectModel);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const grouped = models.reduce<Record<string, ModelDescriptor[]>>(
    (acc, m) => {
      (acc[m.provider] ??= []).push(m);
      return acc;
    },
    {},
  );

  const sortedProviders = providerOrder.filter((p) => grouped[p]);

  const selectedLabel = selectedModel
    ? selectedModel.split(":").slice(1).join(":")
    : "Auto";

  const isLocalSelected = selectedModel?.startsWith("local:");

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 rounded-xl border px-3 py-1.5",
          "text-xs transition-all duration-200",
          isLocalSelected
            ? "border-warning/40 text-warning bg-warning/5"
            : isOpen
              ? "border-primary/40 text-foreground bg-primary/5"
              : "border-border/40 text-muted-foreground/70 hover:text-foreground hover:border-border/70",
        )}
      >
        <Cpu className="h-3.5 w-3.5" />
        <span className="max-w-[120px] truncate font-medium">{selectedLabel}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <div className="animate-fade-in-scale absolute right-0 top-full z-50 mt-2 min-w-[280px] rounded-2xl border border-border/40 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-xl">
          <button
            onClick={() => {
              selectModel(null);
              setIsOpen(false);
            }}
            className={cn(
              "w-full rounded-xl px-3 py-2.5 text-left text-xs transition-all duration-150 hover:bg-accent/60",
              !selectedModel && "bg-primary/10 text-primary",
            )}
          >
            <span className="font-medium">Auto</span>
            <span className="ml-2 text-muted-foreground/50">
              Default provider
            </span>
          </button>

          {sortedProviders.map((provider) => {
            const items = grouped[provider]!;
            const isLocal = provider === "local";
            return (
              <div key={provider} className={cn("mt-1", isLocal && "opacity-40")}>
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <div className="h-px flex-1 bg-border/30" />
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                    {providerLabels[provider]}
                  </span>
                  <div className="h-px flex-1 bg-border/30" />
                </div>
                {items.map((m) => {
                  const value = `${m.provider}:${m.id}`;
                  return (
                    <button
                      key={value}
                      onClick={() => {
                        selectModel(value);
                        setIsOpen(false);
                      }}
                      className={cn(
                        "w-full rounded-xl px-3 py-2 text-left text-xs transition-all duration-150 hover:bg-accent/60",
                        !m.isConfigured && "opacity-30",
                        selectedModel === value && "bg-primary/10 text-primary",
                      )}
                    >
                      <span className="font-mono font-medium">{m.id}</span>
                      {m.roles.includes("default") && m.isConfigured && !isLocal && (
                        <span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          default
                        </span>
                      )}
                      {m.roles.length > 0 && (
                        <span className="ml-1 text-muted-foreground/40">
                          [{m.roles.join(", ")}]
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
