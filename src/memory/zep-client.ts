interface ZepClientDependencies {
    apiKey: string;
    baseUrl: string;
}

type ZepAuthStyle = "api-key-prefix" | "raw";

export interface ZepSessionMemoryResponse {
    context?: string;
    summary?: string;
    relevant_facts?: string[];
    episodes?: Array<{
        uuid?: string;
        content?: string;
        summary?: string;
        created_at?: string;
    }>;
}

export interface ZepGraphSearchResponse {
    results?: unknown[];
    edges?: unknown[];
    nodes?: unknown[];
    episodes?: unknown[];
}

export class ZepClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;

    public constructor(dependencies: ZepClientDependencies) {
        this.apiKey = dependencies.apiKey;
        this.baseUrl = dependencies.baseUrl
            .replace(/\/+$/g, "")
            .replace(/\/api\/v2$/i, "");
    }

    public async ensureUser(userId: string): Promise<void> {
        await this.request("/api/v2/users", {
            method: "POST",
            body: JSON.stringify({ user_id: userId }),
        }, { allowConflict: true });
    }

    public async ensureSession(sessionId: string, userId: string): Promise<void> {
        await this.requestFirstSupported(
            [
                {
                    path: "/api/v2/threads",
                    init: {
                        method: "POST",
                        body: JSON.stringify({
                            thread_id: sessionId,
                            user_id: userId,
                        }),
                    },
                },
                {
                    path: "/api/v2/sessions",
                    init: {
                        method: "POST",
                        body: JSON.stringify({
                            session_id: sessionId,
                            user_id: userId,
                        }),
                    },
                },
            ],
            { allowConflict: true },
        );
    }

    public async getSessionMemory(sessionId: string): Promise<ZepSessionMemoryResponse | null> {
        return this.requestFirstSupportedJson<ZepSessionMemoryResponse>(
            [
                {
                    path: `/api/v2/threads/${encodeURIComponent(sessionId)}/context`,
                    init: { method: "GET" },
                },
                {
                    path: `/api/v2/sessions/${encodeURIComponent(sessionId)}/memory`,
                    init: { method: "GET" },
                },
            ],
            { allowNotFound: true },
        );
    }

    public async addSessionMemory(input: {
        sessionId: string;
        messages: Array<{
            role_type: "user" | "assistant" | "system";
            content: string;
            name?: string;
            created_at?: string;
        }>;
        ignoreRoles?: Array<"user" | "assistant" | "system">;
    }): Promise<void> {
        await this.requestFirstSupported(
            [
                {
                    path: `/api/v2/threads/${encodeURIComponent(input.sessionId)}/messages`,
                    init: {
                        method: "POST",
                        body: JSON.stringify({
                            messages: input.messages.map((message) => ({
                                content: message.content,
                                ...(message.created_at ? { created_at: message.created_at } : {}),
                                ...(message.name ? { name: message.name } : {}),
                                role: message.role_type,
                            })),
                        }),
                    },
                },
                {
                    path: `/api/v2/sessions/${encodeURIComponent(input.sessionId)}/memory`,
                    init: {
                        method: "POST",
                        body: JSON.stringify({
                            messages: input.messages.map((message) => ({
                                content: message.content,
                                ...(message.created_at ? { created_at: message.created_at } : {}),
                                ...(message.name ? { name: message.name } : {}),
                                role_type: message.role_type,
                            })),
                            return_context: false,
                            ...(input.ignoreRoles && input.ignoreRoles.length > 0
                                ? { ignore_roles: input.ignoreRoles }
                                : {}),
                        }),
                    },
                },
            ],
        );
    }

    public async searchGraph(input: {
        userId: string;
        query: string;
        limit: number;
    }): Promise<ZepGraphSearchResponse | null> {
        return this.requestJson<ZepGraphSearchResponse>(
            "/api/v2/graph/search",
            {
                method: "POST",
                body: JSON.stringify({
                    user_id: input.userId,
                    query: input.query,
                    limit: input.limit,
                }),
            },
            { allowNotFound: true },
        );
    }

    private async request(
        path: string,
        init: RequestInit,
        options: {
            allowConflict?: boolean;
        } = {},
    ): Promise<void> {
        const { response, authStyle, url, method } = await this.fetchWithSupportedAuth(path, init);

        if (options.allowConflict && await this.isConflictResponse(response)) {
            return;
        }

        if (!response.ok) {
            throw new Error(await this.toErrorMessage(response, { method, url, authStyle }));
        }
    }

    private async requestFirstSupported(
        candidates: Array<{ path: string; init: RequestInit }>,
        options: {
            allowConflict?: boolean;
        } = {},
    ): Promise<void> {
        let lastFailure:
            | {
                response: Response;
                authStyle: ZepAuthStyle;
                url: string;
                method: string;
            }
            | undefined;

        for (const candidate of candidates) {
            const attempt = await this.fetchWithSupportedAuth(candidate.path, candidate.init);

            if (options.allowConflict && await this.isConflictResponse(attempt.response)) {
                return;
            }

            if (attempt.response.status === 404) {
                lastFailure = attempt;
                continue;
            }

            if (!attempt.response.ok) {
                throw new Error(await this.toErrorMessage(attempt.response, attempt));
            }

            return;
        }

        if (!lastFailure) {
            throw new Error("Zep request failed before any supported endpoint was selected.");
        }

        throw new Error(await this.toErrorMessage(lastFailure.response, lastFailure));
    }

    private async requestJson<T>(
        path: string,
        init: RequestInit,
        options: {
            allowNotFound?: boolean;
        } = {},
    ): Promise<T | null> {
        const { response, authStyle, url, method } = await this.fetchWithSupportedAuth(path, init);

        if (options.allowNotFound && response.status === 404) {
            return null;
        }

        if (!response.ok) {
            throw new Error(await this.toErrorMessage(response, { method, url, authStyle }));
        }

        if (response.status === 204) {
            return null;
        }

        const raw = await response.text();
        if (!raw.trim()) {
            return null;
        }

        return JSON.parse(raw) as T;
    }

    private async requestFirstSupportedJson<T>(
        candidates: Array<{ path: string; init: RequestInit }>,
        options: {
            allowNotFound?: boolean;
        } = {},
    ): Promise<T | null> {
        let lastFailure:
            | {
                response: Response;
                authStyle: ZepAuthStyle;
                url: string;
                method: string;
            }
            | undefined;

        for (const candidate of candidates) {
            const attempt = await this.fetchWithSupportedAuth(candidate.path, candidate.init);

            if (attempt.response.status === 404) {
                lastFailure = attempt;
                continue;
            }

            if (!attempt.response.ok) {
                throw new Error(await this.toErrorMessage(attempt.response, attempt));
            }

            if (attempt.response.status === 204) {
                return null;
            }

            const raw = await attempt.response.text();
            if (!raw.trim()) {
                return null;
            }

            return JSON.parse(raw) as T;
        }

        if (options.allowNotFound) {
            return null;
        }

        if (!lastFailure) {
            throw new Error("Zep request failed before any supported endpoint was selected.");
        }

        throw new Error(await this.toErrorMessage(lastFailure.response, lastFailure));
    }

    private async fetchWithSupportedAuth(
        path: string,
        init: RequestInit,
    ): Promise<{
        response: Response;
        authStyle: ZepAuthStyle;
        url: string;
        method: string;
    }> {
        const url = this.buildUrl(path);
        const method = (init.method ?? "GET").toUpperCase();
        const authStyles: ZepAuthStyle[] = ["api-key-prefix", "raw"];

        let last:
            | {
                response: Response;
                authStyle: ZepAuthStyle;
            }
            | undefined;

        for (const authStyle of authStyles) {
            const response = await fetch(url, {
                ...init,
                headers: this.headers(init.body != null, authStyle),
            });

            if (response.ok || !this.shouldRetryWithAlternateAuth(response.status)) {
                return { response, authStyle, url, method };
            }

            last = { response, authStyle };
        }

        if (!last) {
            throw new Error(`Zep request failed before any response was returned: ${method} ${url}`);
        }

        return {
            response: last.response,
            authStyle: last.authStyle,
            url,
            method,
        };
    }

    private buildUrl(path: string): string {
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        return `${this.baseUrl}${normalizedPath}`;
    }

    private headers(hasBody: boolean, authStyle: ZepAuthStyle): HeadersInit {
        const headers: Record<string, string> = {
            Authorization: authStyle === "raw" ? this.apiKey : `Api-Key ${this.apiKey}`,
            "X-API-Key": this.apiKey,
        };

        if (hasBody) {
            headers["Content-Type"] = "application/json";
        }

        return headers;
    }

    private shouldRetryWithAlternateAuth(status: number): boolean {
        return status === 401 || status === 403;
    }

    private async toErrorMessage(
        response: Response,
        context: {
            method: string;
            url: string;
            authStyle: ZepAuthStyle;
        },
    ): Promise<string> {
        const body = await response.text();
        const prefix =
            `Zep request failed (${response.status}) ${context.method} ${context.url} auth=${context.authStyle}`;
        return body.trim()
            ? `${prefix}: ${body}`
            : prefix;
    }

    private async isConflictResponse(response: Response): Promise<boolean> {
        if (response.status === 409) {
            return true;
        }

        if (response.status !== 400) {
            return false;
        }

        const body = (await response.clone().text()).toLowerCase();
        return body.includes("already exists");
    }
}
