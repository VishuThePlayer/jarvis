import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  language: string;
  children: string;
}

export function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-xl border border-border/30 bg-[#1a1a2e]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
        <div className="flex items-center gap-2">
          <FileCode className="h-3.5 w-3.5 text-muted-foreground/40" />
          <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-muted-foreground/60">
            {language || "text"}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] transition-all duration-200",
            copied
              ? "text-success"
              : "text-muted-foreground/40 hover:bg-white/[0.06] hover:text-muted-foreground",
          )}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        showLineNumbers
        lineNumberStyle={{
          minWidth: "2.5em",
          paddingRight: "1em",
          color: "oklch(0.35 0.015 280)",
          fontSize: "0.8rem",
          userSelect: "none",
        }}
        customStyle={{
          margin: 0,
          padding: "1rem 0.5rem",
          background: "transparent",
          fontSize: "0.825rem",
          lineHeight: 1.65,
        }}
        codeTagProps={{
          style: { fontFamily: '"JetBrains Mono", ui-monospace, monospace' },
        }}
      >
        {children.replace(/\n$/, "")}
      </SyntaxHighlighter>
    </div>
  );
}
