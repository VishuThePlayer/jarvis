import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
    PORT: z
        .string()
        .optional()
        .transform((v) => (v == null || v === "" ? 3000 : Number.parseInt(v, 10)))
        .pipe(z.number().int().positive().max(65535)),
    MODEL: z.string().min(1, "MODEL is required"),
});

function createEnv(env: NodeJS.ProcessEnv) {
    const safeParse = envSchema.safeParse(env);
    if (!safeParse.success) {
        throw new Error(`Invalid environment variables: ${safeParse.error.message}`);
    }
    return safeParse.data;
}

export const env = createEnv(process.env);
