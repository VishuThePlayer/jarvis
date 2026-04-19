import type { ChannelKind } from "../types/core.js";

/**
 * System-instruction blocks so the model emits text suited to each surface.
 * Telegram uses Bot API HTML parse_mode; terminal is raw TTY; HTTP clients often render Markdown.
 */
export function channelFormattingSystemPrompt(channel: ChannelKind): string {
    switch (channel) {
        case "telegram":
            return [
                "Output format - Telegram HTML (messages are sent with parse_mode HTML):",
                "- Style with supported tags only: <b> or <strong>, <i> or <em>, <u>, <s>, <code>, <pre>, <a href=\"https://example.com\">link text</a>, <blockquote>.",
                "- Do not use Markdown (*bold*, **bold**, __, `inline`, ``` fenced blocks) - Telegram will show raw asterisks or reject the message.",
                "- In visible text, escape &, <, > as &amp; &lt; &gt;. Inside <pre>...</pre>, escape those characters in the code/text content.",
                "- Structure: optional <b>Section title</b>, short paragraphs, blank lines (\\n\\n); bullets as lines starting with -.",
                "- Prefer <pre>...</pre> for multi-line code or logs; keep total length reasonable (hard cap ~4000 chars on send).",
            ].join("\n");

        case "terminal":
            return [
                "Output format - terminal (plain text, no renderer):",
                "- No HTML and no Markdown styling - users see raw characters.",
                "- Use short paragraphs, blank lines between sections, ASCII bullets (- or 1.), and indentation for nesting.",
                "- Avoid wide tables; use simple lists or stacked lines instead.",
            ].join("\n");

        case "http":
            return [
                "Output format - HTTP API (often shown in apps or dashboards that render Markdown):",
                "- Markdown is OK: ## headings, **bold**, bullets, fenced ```language code blocks, links.",
                "- Keep hierarchy clear for JSON consumers that strip or render Markdown downstream.",
            ].join("\n");
    }
}

/** Escape text so it can be embedded in Telegram HTML (e.g. inside &lt;pre&gt;). */
export function escapeTelegramHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strip minimal HTML-ish content for Telegram retry when parse_mode fails. */
export function telegramPlainFallback(parsedHtml: string): string {
    return parsedHtml
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 4096);
}
