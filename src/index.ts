export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-v4-flash";

export type AppConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

type Env = Partial<Record<string, string>>;

export function readConfig(env: Env = process.env): AppConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "缺少 DEEPSEEK_API_KEY。请先设置环境变量后再运行 pnpm chat。",
    );
  }

  return {
    apiKey,
    baseURL: env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL,
    model: env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export function isExitCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "exit" || normalized === "quit";
}

export function extractDelta(chunk: {
  choices?: Array<{ delta?: { content?: string | null } }>;
}): string {
  return chunk.choices?.[0]?.delta?.content ?? "";
}
