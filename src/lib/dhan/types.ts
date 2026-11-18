export type ExchangeSegment =
  | "IDX_I"
  | "NSE_EQ"
  | "NSE_FNO"
  | "NSE_CURRENCY"
  | "BSE_EQ"
  | "MCX_COMM"
  | "BSE_CURRENCY"
  | "BSE_FNO";

export type ProductType = "CNC" | "INTRADAY" | "MARGIN" | "MTF" | "CO" | "BO";
export type TransactionType = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET" | "STOP_LOSS" | "STOP_LOSS_MARKET";
export type OrderValidity = "DAY" | "IOC";
export type OrderStatus =
  | "TRANSIT"
  | "PENDING"
  | "CLOSED"
  | "TRIGGERED"
  | "REJECTED"
  | "CANCELLED"
  | "PART_TRADED"
  | "TRADED"
  | "EXPIRED";
export type OptionType = "CALL" | "PUT" | "NA";
export type ActiveStatus = "Active" | "Deactive";

export interface DhanProfile {
  dhanClientId: string;
  /** "DD/MM/YYYY HH:mm" in IST */
  tokenValidity: string;
  /** Comma-separated segment codes, e.g. "E, D, M, " */
  activeSegment: string;
  ddpi: ActiveStatus;
  mtf: ActiveStatus;
  dataPlan: ActiveStatus;
  dataValidity: string;
}

export interface DhanFundLimit {
  dhanClientId: string;
  /** Misspelled by the Dhan API; keep as is. */
  availabelBalance: number;
  sodLimit: number;
  collateralAmount: number;
  receiveableAmount: number;
  utilizedAmount: number;
  blockedPayoutAmount: number;
  withdrawableBalance: number;
}

export interface DhanPosition {
  dhanClientId: string;
  tradingSymbol: string;
  securityId: string;
  positionType: "LONG" | "SHORT" | "CLOSED";
  exchangeSegment: ExchangeSegment;
  productType: ProductType;
  buyAvg: number;
  costPrice: number;
  buyQty: number;
  sellAvg: number;
  sellQty: number;
  netQty: number;
  realizedProfit: number;
  unrealizedProfit: number;
  rbiReferenceRate: number;
  multiplier: number;
  carryForwardBuyQty: number;
  carryForwardSellQty: number;
  carryForwardBuyValue: number;
  carryForwardSellValue: number;
  dayBuyQty: number;
  daySellQty: number;
  dayBuyValue: number;
  daySellValue: number;
  drvExpiryDate: string;
  drvOptionType: OptionType;
  drvStrikePrice: number;
  crossCurrency: boolean;
}

export interface DhanHolding {
  exchange: "NSE" | "BSE" | "MCX" | "ALL";
  tradingSymbol: string;
  securityId: string;
  isin: string;
  totalQty: number;
  dpQty: number;
  t1Qty: number;
  mtf_t1_qty: number;
  mtf_qty: number;
  availableQty: number;
  collateralQty: number;
  avgCostPrice: number;
  lastTradedPrice: number;
}

export interface DhanOrder {
  dhanClientId: string;
  orderId: string;
  exchangeOrderId: string;
  correlationId: string;
  orderStatus: OrderStatus;
  transactionType: TransactionType;
  exchangeSegment: ExchangeSegment;
  productType: ProductType;
  orderType: OrderType;
  validity: OrderValidity;
  tradingSymbol: string;
  securityId: string;
  quantity: number;
  disclosedQuantity: number;
  price: number;
  triggerPrice: number;
  afterMarketOrder: boolean;
  boProfitValue: number;
  boStopLossValue: number;
  legName: "ENTRY_LEG" | "STOP_LOSS_LEG" | "TARGET_LEG" | "NA";
  createTime: string;
  updateTime: string;
  exchangeTime: string;
  drvExpiryDate: string;
  drvOptionType: OptionType;
  drvStrikePrice: number;
  omsErrorCode: string;
  omsErrorDescription: string;
  algoId: string;
  remainingQuantity: number;
  averageTradedPrice: number;
  filledQty: number;
}

export type InstrumentsBySegment = Partial<Record<ExchangeSegment, number[]>>;

export type LtpData = Partial<
  Record<ExchangeSegment, Record<string, { last_price: number }>>
>;

export interface Underlying {
  securityId: number;
  segment: ExchangeSegment;
}

export type ChartInstrument =
  | "INDEX"
  | "FUTIDX"
  | "OPTIDX"
  | "EQUITY"
  | "FUTSTK"
  | "OPTSTK"
  | "FUTCOM"
  | "OPTFUT";

export interface IntradayCandleRequest {
  securityId: string;
  exchangeSegment: ExchangeSegment;
  instrument: ChartInstrument;
  interval: "1" | "5" | "15" | "25" | "60";
  /** "YYYY-MM-DD" */
  fromDate: string;
  /** "YYYY-MM-DD" */
  toDate: string;
}

/** Daily bars, `/charts/historical`. `toDate` is exclusive. */
export interface DailyCandleRequest {
  securityId: string;
  exchangeSegment: ExchangeSegment;
  instrument: ChartInstrument;
  /** "YYYY-MM-DD" */
  fromDate: string;
  /** "YYYY-MM-DD", not included */
  toDate: string;
}

/** Parallel arrays; `timestamp` is epoch seconds (for daily bars, midnight IST of the day). */
export interface IntradayCandles {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  timestamp: number[];
  open_interest?: number[];
}

export interface OptionGreeks {
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
}

export interface OptionLeg {
  security_id: number;
  last_price: number;
  average_price: number;
  previous_close_price: number;
  implied_volatility: number;
  greeks: OptionGreeks;
  oi: number;
  previous_oi: number;
  volume: number;
  previous_volume: number;
  top_bid_price: number;
  top_bid_quantity: number;
  top_ask_price: number;
  top_ask_quantity: number;
}

export interface OptionChain {
  last_price: number;
  /** Keyed by strike, e.g. "25650.000000" */
  oc: Record<string, { ce?: OptionLeg; pe?: OptionLeg }>;
}
