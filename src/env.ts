import { z } from "zod";

const envSchema = z.object({
    OPENROUTER_API_KEY: z.string(),
    PORT: z.number().default(3000),
})

function createEnv(env: NodeJS.ProcessEnv) {
    const safeParse = envSchema.safeParse(env);
    if(!safeParse.success) {
        throw new Error(`Invalid environment variables: ${safeParse.error.message}`);
    }
    return safeParse.data;
}

export const env = createEnv(process.env)