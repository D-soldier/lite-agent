import OpenAI from "openai";
import { pathToFileURL } from "node:url";
import { loadEnvFile, readConfig } from "./config";
import { runChatLoop, formatError } from "./chat";

export function createClient(config = readConfig()): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

export function isDirectRun(metaUrl: string, argvPath?: string): boolean {
  if (!argvPath) {
    return false;
  }

  const candidates = [pathToFileURL(argvPath).href];

  if (argvPath.startsWith("/")) {
    candidates.push(`file://${argvPath}`);
  }

  return candidates.includes(metaUrl);
}

export async function main(): Promise<void> {
  try {
    loadEnvFile();
    const config = readConfig();
    const client = createClient(config);
    await runChatLoop({ client, model: config.model, writeRoot: config.writeRoot });
  } catch (error) {
    console.error(`错误：${formatError(error)}`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
