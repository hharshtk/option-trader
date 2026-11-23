export interface OfiReplayDelay {
  delayMs: number;
  breadth: { trades: number; net: number };
  confirmed: { trades: number; net: number };
  /** Net rupees per opportunity with a grade, including missed entries and policy skips as zero. */
  liftPerOpportunity: number | null;
  missedEntries: number;
  unpricedExits: number;
  skipped: {
    disagreement: { count: number; breadthNet: number };
    abstention: { count: number; breadthNet: number };
    flat: { count: number; breadthNet: number };
  };
}

export interface OfiReplayComparison {
  date: string;
  exploratory: boolean;
  /** Nonzero breadth votes before the cutoff quote and contract checks. */
  votes: number;
  opportunities: number;
  covered: number;
  hasDepth: boolean;
  hasOptionQuotes: boolean;
  partialRecording: boolean;
  abstentions: { missing: number; stale: number; invalid: number; warmup: number };
  primaryDelayMs: number;
  delays: OfiReplayDelay[];
}

export type OfiReplayStatus =
  | { state: "idle" }
  | { state: "running"; date: string }
  | { state: "ready"; comparison: OfiReplayComparison }
  | { state: "failed"; message: string };
