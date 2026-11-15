import { RATE_LIMIT_COOLDOWN_MS } from "./rate-limit";

const AUTH_ERROR_CODES = new Set(["DH-901", "807", "808", "809", "810"]);
const RATE_LIMIT_ERROR_CODES = new Set(["DH-904", "805"]);
const DATA_PLAN_ERROR_CODE = "806";

export class DhanConfigError extends Error {
  name = "DhanConfigError";
}

interface DhanApiErrorDetails {
  status: number;
  code?: string;
  type?: string;
  cause?: unknown;
}

export class DhanApiError extends Error {
  name = "DhanApiError";
  readonly status: number;
  readonly code?: string;
  readonly type?: string;

  constructor(message: string, { status, code, type, cause }: DhanApiErrorDetails) {
    super(message, { cause });
    this.status = status;
    this.code = code;
    this.type = type;
  }

  get isAuthError() {
    return this.code !== undefined && AUTH_ERROR_CODES.has(this.code);
  }

  get isDataPlanError() {
    return this.code === DATA_PLAN_ERROR_CODE;
  }

  get isRateLimitError() {
    return (
      this.status === 429 ||
      (this.code !== undefined && RATE_LIMIT_ERROR_CODES.has(this.code))
    );
  }
}

export interface DhanErrorDescription {
  message: string;
  code?: string;
  hint?: string;
}

export function describeDhanError(error: unknown): DhanErrorDescription {
  if (error instanceof DhanConfigError) {
    return {
      message: error.message,
      hint: "Copy .env.example to .env.local, fill in your Dhan client ID and access token, then restart the dev server.",
    };
  }

  if (error instanceof DhanApiError) {
    let hint: string | undefined;
    if (error.isRateLimitError) {
      hint = `After a rate-limit warning from Dhan, this app stops sending any requests for ${RATE_LIMIT_COOLDOWN_MS / 1000} seconds. Wait before refreshing.`;
    } else if (error.isAuthError) {
      hint =
        "Generate a new access token at web.dhan.co → My Profile → Access DhanHQ APIs, then save it on the Settings page.";
    } else if (error.isDataPlanError) {
      hint =
        "Quotes and option chains need Dhan's Data API subscription, which is separate from trading API access. Subscribe from your DhanHQ API settings on web.dhan.co.";
    }
    return { message: error.message, code: error.code, hint };
  }

  return { message: error instanceof Error ? error.message : String(error) };
}
