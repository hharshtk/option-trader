import "server-only";
import { DhanConfigError } from "./errors";

export interface DhanCredentials {
  clientId: string;
  accessToken: string;
}

export function getDhanCredentials(): DhanCredentials {
  const clientId = process.env.DHAN_CLIENT_ID?.trim();
  const accessToken = process.env.DHAN_ACCESS_TOKEN?.trim();

  if (!clientId || !accessToken) {
    const missing = [
      !clientId && "DHAN_CLIENT_ID",
      !accessToken && "DHAN_ACCESS_TOKEN",
    ].filter(Boolean);
    throw new DhanConfigError(`Missing ${missing.join(" and ")} in .env.local`);
  }

  return { clientId, accessToken };
}

export function getAccessTokenExpiry(accessToken: string): Date | null {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"),
    );
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}
