const WORD_PATTERN = /[a-z0-9]+/gi;

export function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function tokenize(text: string): string[] {
    return (text.toLowerCase().match(WORD_PATTERN) ?? []).filter((token) => token.length > 1);
}

export function keywordOverlapScore(queryTokens: string[], candidateTokens: string[]): number {
    if (queryTokens.length === 0 || candidateTokens.length === 0) {
        return 0;
    }

    const candidateSet = new Set(candidateTokens);
    let matches = 0;

    for (const token of queryTokens) {
        if (candidateSet.has(token)) {
            matches += 1;
        }
    }

    return matches / queryTokens.length;
}

export function toTitleFromMessage(message: string): string {
    const cleaned = normalizeWhitespace(message);

    if (cleaned.length <= 60) {
        return cleaned || "New conversation";
    }

    return `${cleaned.slice(0, 57).trimEnd()}...`;
}

export function splitBulletLines(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2));
}
