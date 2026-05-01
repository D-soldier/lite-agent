import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-v4-flash";

export type AppConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  writeRoot: string;
};

type Env = Partial<Record<string, string>>;

export function loadEnvFile(
  envFilePath = ".env",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = loadDotenv({
    path: envFilePath,
    processEnv: env,
    override: false,
    quiet: true,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;

  if (error && error.code !== "ENOENT") {
    throw error;
  }
}

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
    writeRoot: resolve(env.LITE_AGENT_WRITE_ROOT?.trim() || process.cwd()),
  };
}
