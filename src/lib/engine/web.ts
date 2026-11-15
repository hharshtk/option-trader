import "server-only";

// How the web reaches the engine's control API. Without ENGINE_URL the web works exactly as
// before and the engine panels say the engine isn't configured.

export interface EngineConfig {
  url: string;
  token: string;
}

export function engineConfig(): EngineConfig | null {
  const url = process.env.ENGINE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.ENGINE_TOKEN?.trim();
  return url && token ? { url, token } : null;
}
