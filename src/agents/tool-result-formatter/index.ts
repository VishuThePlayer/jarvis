import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../config/index.js";
import type { ModelInvocation, ToolCallRecord, UserRequest } from "../../types/core.js";
import { formatToolInput } from "../../utils/tool-input.js";

export interface ToolResultFormatter {
    id: string;
    prepareInvocation(input: { request: UserRequest; toolCall: ToolCallRecord }): Promise<ModelInvocation>;
}

interface FormatProfile {
    name: "brief" | "analysis" | "steps";
    structure: string;
    maxLengthHint: string;
}

interface SkillDoc {
    name: string;
    path: string;
    content: string;
}

export class ToolResultFormatterAgent implements ToolResultFormatter {
    public readonly id = "tool-result-formatter";
    private readonly config: AppConfig;
    private readonly skills: SkillDoc[];

    public constructor(config: AppConfig) {
        this.config = config;
        this.skills = this.loadSkills();
    }

    public async prepareInvocation(input: {
        request: UserRequest;
        toolCall: ToolCallRecord;
    }): Promise<ModelInvocation> {
        const { request, toolCall } = input;
        const profile = this.pickFormatProfile(request.message, toolCall);
        const formattingPrompt = this.buildFormattingPrompt(profile, toolCall);
        const skillContext = this.buildSkillContext(request, toolCall);
        const formattedInput = formatToolInput(toolCall.input);

        return {
            model: this.config.models.fast,
            temperature: 0.1,
            messages: [
                {
                    role: "system",
                    content: formattingPrompt,
                },
                {
                    role: "user",
                    content:
                        `User question: ${request.message}\n\n` +
                        `Tool name: ${toolCall.name}\n` +
                        `Tool success: ${toolCall.success}\n` +
                        `Tool input: ${formattedInput}\n` +
                        `Tool output:\n${toolCall.output}\n\n` +
                        `Formatting profile: ${profile.name}\n` +
                        `${skillContext}\n` +
                        "Answer the user's question using only this tool output.",
                },
            ],
        };
    }

    private pickFormatProfile(message: string, toolCall: ToolCallRecord): FormatProfile {
        const text = `${message} ${formatToolInput(toolCall.input)}`.toLowerCase();

        if (!toolCall.success) {
            return {
                name: "brief",
                structure:
                    "State what failed in one sentence based only on the tool output. Ask one short clarifying question if needed.",
                maxLengthHint: "Max 60 words. Avoid internal command names unless the user asked for them.",
            };
        }

        if (
            /\b(how\s+to|steps|fix|resolve|install|setup|configure|what should i do|walk\s+me\s+through)\b/.test(text)
        ) {
            return {
                name: "steps",
                structure:
                    "Lead with the outcome, then give at most 4 short bullets with real next steps. Do not fake detail.",
                maxLengthHint: "Keep under 160 words unless the user asked for detail.",
            };
        }

        if (/\b(suspicious|security|weird|malware|safe|risk|analy[sz]e|diagnos)/i.test(text)) {
            return {
                name: "analysis",
                structure: "Start with a verdict, then group the findings into short bullets and include confidence.",
                maxLengthHint: "Keep under 240 words unless the user asked for a full report.",
            };
        }

        return {
            name: "brief",
            structure: "Answer directly first. Add at most 4 short bullets only when they add real value.",
            maxLengthHint: "Keep under 120 words unless the user asked for more.",
        };
    }

    private buildFormattingPrompt(profile: FormatProfile, toolCall: ToolCallRecord): string {
        const lines = [
            "You format raw tool output into a clean user-facing answer.",
            "Rules:",
            "- Ground every claim in the provided tool output.",
            "- Be concise.",
            "- Use at most 4 bullets unless the user explicitly asked for a long list.",
            "- Do not mention prompts, routing, or hidden system behavior.",
            "- Do not ask for a full Windows path unless the tool output makes that necessary.",
        ];

        if (toolCall.name === "ps-app" || toolCall.name === "ps-folder") {
            lines.push(
                "- For folders and projects, directories belong to ps-folder. Do not suggest ps-app for directory paths.",
            );
        }

        lines.push(
            "",
            `Profile: ${profile.name}`,
            `Structure guidance: ${profile.structure}`,
            `Length guidance: ${profile.maxLengthHint}`,
        );
        return lines.join("\n");
    }

    private loadSkills(): SkillDoc[] {
        const skillsDir = join(process.cwd(), "src", "skills");
        if (!existsSync(skillsDir)) {
            return [];
        }

        const files = readdirSync(skillsDir).filter((name) => name.toLowerCase().endsWith(".md"));
        return files.map((file) => {
            const path = join(skillsDir, file);
            const content = readFileSync(path, "utf8");
            return {
                name: file.replace(/\.md$/i, ""),
                path,
                content,
            };
        });
    }

    private buildSkillContext(request: UserRequest, toolCall: ToolCallRecord): string {
        if (this.skills.length === 0) {
            return "Available skills: none";
        }

        const available = this.skills.map((skill) => skill.name).join(", ");
        const relevant = this.selectRelevantSkills(request, toolCall);

        if (relevant.length === 0) {
            return `Available skills: ${available}\nRelevant skills used: none`;
        }

        const consumed = relevant
            .map((skill) => `- ${skill.name}: ${this.extractSkillSnippet(skill.content)}`)
            .join("\n");

        return `Available skills: ${available}\nRelevant skills used:\n${consumed}`;
    }

    private selectRelevantSkills(request: UserRequest, toolCall: ToolCallRecord): SkillDoc[] {
        const query = `${request.message} ${toolCall.name} ${formatToolInput(toolCall.input)}`.toLowerCase();

        return this.skills
            .map((skill) => ({
                skill,
                score: this.scoreSkill(query, skill),
            }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score)
            .slice(0, 2)
            .map((entry) => entry.skill);
    }

    private scoreSkill(query: string, skill: SkillDoc): number {
        let score = 0;
        if (query.includes(skill.name.toLowerCase())) {
            score += 3;
        }
        if (query.includes("powershell") && skill.name.toLowerCase().includes("powershell")) {
            score += 4;
        }

        const keywords = ["process", "service", "network", "file", "search", "open", "security", "tool"];
        for (const keyword of keywords) {
            if (query.includes(keyword) && skill.content.toLowerCase().includes(keyword)) {
                score += 1;
            }
        }

        return score;
    }

    private extractSkillSnippet(content: string): string {
        return content
            .replace(/\r/g, "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(0, 2)
            .join(" ")
            .slice(0, 220);
    }
}
