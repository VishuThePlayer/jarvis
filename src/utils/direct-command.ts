export function getDirectCommandArgText(message: string, command: string): string | null {
    const trimmed = message.trim();
    const commandLower = command.toLowerCase();
    const trimmedLower = trimmed.toLowerCase();

    if (trimmedLower === commandLower) {
        return "";
    }

    if (!trimmedLower.startsWith(`${commandLower} `)) {
        return null;
    }

    return trimmed.slice(command.length).trim();
}
