import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ChannelKind, ToolCallRecord, UserRequest } from "../types/core.js";
import { getDirectCommandArgText } from "../utils/direct-command.js";
import { keywordOverlapScore, normalizeWhitespace, tokenize } from "../utils/text.js";
import { createToolInput } from "../utils/tool-input.js";
import { createToolRecord } from "../utils/tool-record.js";
import type { CommandToolDescriptor, CommandToolInvocation } from "./contracts.js";

interface TimeToolDependencies {
    config: AppConfig;
    logger: Logger;
}

interface GeoResult {
    label: string;
    timezone: string;
}

interface OpenMeteoGeocodeResponse {
    results?: Array<{
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

export class TimeTool {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly geocodeCache = new Map<string, { expiresAt: number; value: ResolveLocationResult }>();

    public constructor(dependencies: TimeToolDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
    }

    public describe(): CommandToolDescriptor {
        return {
            name: "time",
            description:
                "Get the current time locally or for a city/place. Use this for direct time requests such as 'what time is it in Boston'.",
            command: "time",
            argsHint: "[place]",
            examples: ["time", "time Boston, MA"],
            autoRoute: true,
            parameters: {
                type: "object",
                properties: {
                    place: {
                        type: "string",
                        description: "City or location to get the time for. Omit for local/UTC time.",
                    },
                },
                required: [],
            },
        };
    }

    public isEnabled(channel: ChannelKind): boolean {
        return this.config.tools.time.enabled && this.config.tools.time.perChannel[channel];
    }

    public matchDirectInvocation(request: UserRequest): CommandToolInvocation | null {
        if (!this.isEnabled(request.channel)) {
            return null;
        }

        const argText = getDirectCommandArgText(request.message, this.describe().command);
        if (argText == null) {
            return null;
        }

        const place = this.cleanPlace(argText);
        return {
            request,
            source: "direct-command",
            arguments: place ? { place } : {},
        };
    }

    public async execute(invocation: CommandToolInvocation): Promise<ToolCallRecord> {
        const place = this.readPlace(invocation.arguments);
        const input = createToolInput(invocation.source, invocation.request.message, place ? { place } : {});

        try {
            const now = new Date();

            if (!place) {
                return this.record(input, true, this.formatLocalTime(now));
            }

            const resolved = await this.resolveLocation(place);

            if (resolved.kind === "none") {
                return this.record(input, false, `Could not find "${resolved.query}". Try e.g. "Boston, MA".`);
            }

            if (resolved.kind === "ambiguous") {
                const suggestions = resolved.options.slice(0, 3).map((o) => `- time ${o.label}`).join("\n");
                return this.record(input, false, `Ambiguous: "${resolved.query}". Did you mean:\n${suggestions}`);
            }

            const formatted = this.formatTimeInZone(now, resolved.result.timezone);
            return this.record(input, true, `Time\n- ${resolved.result.label}: ${formatted} (${resolved.result.timezone})\n- utc: ${now.toISOString()}`);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.logger.warn("Time tool failed", { error: text });
            return this.record(input, false, `Time tool failed: ${text}`);
        }
    }

    private record(input: ReturnType<typeof createToolInput>, success: boolean, output: string) {
        return createToolRecord("time", input, success, output);
    }

    private readPlace(args: Record<string, unknown>): string | null {
        const raw = args.place;
        return typeof raw === "string" ? this.cleanPlace(raw) : null;
    }

    private cleanPlace(raw: string | undefined): string | null {
        if (!raw) return null;

        const cleaned = normalizeWhitespace(raw)
            .replace(/^[\s:,-]+/, "")
            .replace(/[?.!]+$/, "")
            .replace(/^in\s+/i, "")
            .trim();

        if (!cleaned || /^(here|local|system)$/i.test(cleaned)) return null;
        return cleaned;
    }

    private formatLocalTime(now: Date): string {
        const local = now.toLocaleString("en-US", {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        });
        const offset = -now.getTimezoneOffset();
        const sign = offset >= 0 ? "+" : "-";
        const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
        const m = String(Math.abs(offset) % 60).padStart(2, "0");
        return `Time\n- local: ${local} (UTC${sign}${h}:${m})\n- utc: ${now.toISOString()}`;
    }

    private formatTimeInZone(date: Date, timeZone: string): string {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false, timeZoneName: "short",
        }).formatToParts(date);

        const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
        const stamp = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
        const tz = get("timeZoneName");
        return tz ? `${stamp} ${tz}` : stamp;
    }

    private async resolveLocation(query: string): Promise<ResolveLocationResult> {
        if (query.length > 120) return { kind: "none", query: query.slice(0, 120) };

        const cacheKey = query.toLowerCase();
        const cached = this.geocodeCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.value;

        const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
        url.searchParams.set("name", query);
        url.searchParams.set("count", "3");
        url.searchParams.set("language", "en");
        url.searchParams.set("format", "json");

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Open-Meteo geocoding returned ${response.status}`);

        const data = (await response.json()) as OpenMeteoGeocodeResponse;
        const options = (data.results ?? [])
            .filter((r): r is Required<Pick<(typeof r), "name" | "timezone">> & typeof r =>
                Boolean(r.name?.trim()) && Boolean(r.timezone?.trim()),
            )
            .map((r) => ({
                label: [r.name!.trim(), r.admin1?.trim(), r.country?.trim()].filter(Boolean).join(", "),
                timezone: r.timezone!.trim(),
            }));

        const resolved = this.pickBestMatch(query, options);

        this.geocodeCache.set(cacheKey, { value: resolved, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        return resolved;
    }

    private pickBestMatch(query: string, options: GeoResult[]): ResolveLocationResult {
        if (options.length === 0) return { kind: "none", query };
        if (options.length === 1) return { kind: "hit", result: options[0]! };

        const queryTokens = tokenize(query);
        const scored = options
            .map((option) => ({ option, score: keywordOverlapScore(queryTokens, tokenize(option.label)) }))
            .sort((a, b) => b.score - a.score);

        const best = scored[0]!;
        const second = scored[1];

        if (best.score > 0 && (!second || best.score > second.score)) {
            return { kind: "hit", result: best.option };
        }
        return { kind: "ambiguous", query, options };
    }
}
