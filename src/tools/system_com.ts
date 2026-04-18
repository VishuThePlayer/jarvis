import type { Logger } from "../observability/logger.js";
import type { AppConfig } from "../config/index.js";
import { createId } from "../utils/id.js";
import type { ToolCallRecord, UserRequest } from "../types/core.js";
import type { CommandToolDescriptor } from "./contracts.js";
import { keywordOverlapScore, normalizeWhitespace, tokenize } from "../utils/text.js";

interface SystemComToolDependencies {
    config: AppConfig;
    logger: Logger;
}

/**
 * Commands (trimmed):
 * - `/time`, `/sys time`, `/sys get-time`
 * - `//time`, `//sys time`, `//sys get-time`
 * Telegram may append `@botname` in groups (e.g. `/time@my_bot`).
 */
const SYSTEM_COMMAND_RE = /^(?:\/\/|\/)(?:sys\s+)?(get-time|time)(?:@\w+)?(?:\s+(.+))?$/i;

interface GeoResult {
    label: string;
    timezone: string;
    latitude: number;
    longitude: number;
}

interface OpenMeteoGeocodeResponse {
    results?: Array<{
        id?: number;
        name?: string;
        latitude?: number;
        longitude?: number;
        timezone?: string;
        country?: string;
        admin1?: string;
    }>;
}

type ResolveLocationResult =
    | { kind: "hit"; result: GeoResult }
    | { kind: "ambiguous"; query: string; options: GeoResult[] }
    | { kind: "none"; query: string };

export class SystemComTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly geocodeCache = new Map<string, { expiresAt: number; value: ResolveLocationResult }>();

    public constructor(dependencies: SystemComToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "system-com",
            description: "Return server local time and UTC time.",
            command: "//time",
            argsHint: "[place]",
            examples: ["//time", "//time Boston, MA", "/time", "/sys time", "/sys get-time"],
            autoRoute: true,
        };
    }

    public shouldRun(request: UserRequest): boolean {
        if (!this.config.tools.systemCom.enabled) {
            return false;
        }

        if (!this.config.tools.systemCom.perChannel[request.channel]) {
            return false;
        }

        return SYSTEM_COMMAND_RE.test(request.message.trim());
    }

    private parseInvocation(message: string): { place?: string } | null {
        const match = message.trim().match(SYSTEM_COMMAND_RE);
        const cmd = match?.[1]?.toLowerCase();
        if (cmd !== "time" && cmd !== "get-time") {
            return null;
        }

        const rawPlace = match?.[2]?.trim();
        if (!rawPlace) {
            return {};
        }

        const cleaned = normalizeWhitespace(rawPlace).replace(/^in\s+/i, "").trim();
        if (!cleaned) {
            return {};
        }

        if (/^(here|local|system)$/i.test(cleaned)) {
            return {};
        }

        return { place: cleaned };
    }

    public async execute(message: string): Promise<ToolCallRecord> {
        const createdAt = new Date();
        const input = message.trim();
        const invocation = this.parseInvocation(message);

        if (!invocation) {
            return {
                id: createId("tool"),
                name: "system-com",
                input,
                output: "No recognized system command.",
                success: false,
                createdAt,
            };
        }

        try {
            const now = new Date();

            if (!invocation.place) {
                const output = `Time\n- local: ${this.formatLocalDateTime(now)} (UTC${this.formatUtcOffset(now)})\n- utc: ${now.toISOString()}`;
                return {
                    id: createId("tool"),
                    name: "system-com",
                    input,
                    output,
                    success: true,
                    createdAt,
                };
            }

            const resolved = await this.resolveLocation(invocation.place);
            if (resolved.kind === "none") {
                return {
                    id: createId("tool"),
                    name: "system-com",
                    input,
                    output: `I could not find a location for "${resolved.query}". Try a more specific place, e.g. "Boston, MA".`,
                    success: false,
                    createdAt,
                };
            }

            if (resolved.kind === "ambiguous") {
                const bullets = resolved.options
                    .slice(0, 3)
                    .map((option) => `- //time ${option.label}`)
                    .join("\n");
                return {
                    id: createId("tool"),
                    name: "system-com",
                    input,
                    output: `That location is ambiguous: "${resolved.query}". Try one of:\n${bullets}`,
                    success: false,
                    createdAt,
                };
            }

            const formatted = this.formatTimeInTimeZone(now, resolved.result.timezone);
            const output = `Time\n- ${resolved.result.label}: ${formatted} (${resolved.result.timezone})\n- utc: ${now.toISOString()}`;
            return {
                id: createId("tool"),
                name: "system-com",
                input,
                output,
                success: true,
                createdAt,
            };
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.logger.warn("System command failed", { error: text });

            return {
                id: createId("tool"),
                name: "system-com",
                input,
                output: `System command failed: ${text}`,
                success: false,
                createdAt,
            };
        }
    }

    private formatLocalDateTime(date: Date): string {
        return date.toLocaleString("en-US", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
    }

    private formatUtcOffset(date: Date): string {
        // getTimezoneOffset() returns minutes behind UTC (e.g. PST -> 480)
        const totalMinutes = -date.getTimezoneOffset();
        const sign = totalMinutes >= 0 ? "+" : "-";
        const absMinutes = Math.abs(totalMinutes);
        const hours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
        const minutes = String(absMinutes % 60).padStart(2, "0");
        return `${sign}${hours}:${minutes}`;
    }

    private formatTimeInTimeZone(date: Date, timeZone: string): string {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
            timeZoneName: "short",
        });

        const parts = formatter.formatToParts(date);
        type PartType = "year" | "month" | "day" | "hour" | "minute" | "second" | "timeZoneName";
        const get = (type: PartType) => parts.find((part) => part.type === type)?.value ?? "";

        const year = get("year");
        const month = get("month");
        const day = get("day");
        const hour = get("hour");
        const minute = get("minute");
        const second = get("second");
        const tzName = get("timeZoneName");

        const formatted = `${year}-${month}-${day} ${hour}:${minute}:${second}`.trim();
        return tzName ? `${formatted} ${tzName}` : formatted;
    }

    private async resolveLocation(query: string): Promise<ResolveLocationResult> {
        const cleaned = normalizeWhitespace(query);
        if (!cleaned) {
            return { kind: "none", query };
        }

        if (cleaned.length > 120) {
            return { kind: "none", query: cleaned.slice(0, 120) };
        }

        const cacheKey = cleaned.toLowerCase();
        const cached = this.geocodeCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value;
        }

        const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
        url.searchParams.set("name", cleaned);
        url.searchParams.set("count", "3");
        url.searchParams.set("language", "en");
        url.searchParams.set("format", "json");

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Open-Meteo geocoding returned ${response.status}`);
        }

        const data = (await response.json()) as OpenMeteoGeocodeResponse;
        const rawResults = data.results ?? [];
        const options = rawResults
            .map((result): GeoResult | null => {
                const name = result.name?.trim();
                const timezone = result.timezone?.trim();
                const latitude = result.latitude;
                const longitude = result.longitude;
                if (!name || !timezone || typeof latitude !== "number" || typeof longitude !== "number") {
                    return null;
                }

                const admin1 = result.admin1?.trim();
                const country = result.country?.trim();
                const label = [name, admin1, country].filter(Boolean).join(", ");
                return { label, timezone, latitude, longitude };
            })
            .filter((item): item is GeoResult => Boolean(item));

        let resolved: ResolveLocationResult;
        if (options.length === 0) {
            resolved = { kind: "none", query: cleaned };
        } else if (options.length === 1) {
            const only = options[0];
            resolved = only ? { kind: "hit", result: only } : { kind: "none", query: cleaned };
        } else {
            const queryTokens = tokenize(cleaned);
            const scored = options
                .map((option) => ({
                    option,
                    score: keywordOverlapScore(queryTokens, tokenize(option.label)),
                }))
                .sort((left, right) => right.score - left.score);

            const best = scored[0];
            const second = scored[1];

            if (!best) {
                resolved = { kind: "none", query: cleaned };
            } else if (best.score > 0 && (!second || best.score > second.score)) {
                resolved = { kind: "hit", result: best.option };
            } else {
                resolved = { kind: "ambiguous", query: cleaned, options };
            }
        }

        this.geocodeCache.set(cacheKey, {
            value: resolved,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });

        return resolved;
    }
}
