import type { Underlying } from "./types";

// Security IDs from Dhan's instrument master (images.dhan.co/api-data/api-scrip-master.csv).
export const INDEX = {
  NIFTY: { securityId: 13, segment: "IDX_I" },
  BANKNIFTY: { securityId: 25, segment: "IDX_I" },
  FINNIFTY: { securityId: 27, segment: "IDX_I" },
  MIDCPNIFTY: { securityId: 442, segment: "IDX_I" },
  SENSEX: { securityId: 51, segment: "IDX_I" },
  BANKEX: { securityId: 69, segment: "IDX_I" },
} as const satisfies Record<string, Underlying>;
