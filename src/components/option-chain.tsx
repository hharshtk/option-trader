import Link from "next/link";
import type { ReactNode } from "react";
import type { OptionChain, OptionLeg } from "@/lib/dhan";
import { compactNumber, percentChange, price, quantity, signedCompactNumber } from "@/lib/format";
import { CenterOnMount } from "./center-on-mount";
import { EmptyState } from "./ui";

export const STRIKES_EACH_SIDE = 15;

const CALL_COLUMNS = ["OI", "OI chg", "Volume", "IV", "LTP"];
const PUT_COLUMNS = ["LTP", "IV", "Volume", "OI chg", "OI"];

interface StrikeRow {
  strike: number;
  ce?: OptionLeg;
  pe?: OptionLeg;
}

export function OptionChainTable({
  chain,
  underlyingName,
  scrollToken,
  showAll,
  toggleHref,
}: {
  chain: OptionChain;
  underlyingName: string;
  scrollToken: string;
  showAll: boolean;
  toggleHref: string;
}) {
  const strikes: StrikeRow[] = Object.entries(chain.oc ?? {})
    .map(([key, legs]) => ({ strike: Number(key), ce: legs?.ce, pe: legs?.pe }))
    .filter((row) => Number.isFinite(row.strike))
    .sort((a, b) => a.strike - b.strike);

  if (strikes.length === 0) {
    return (
      <div className="p-3">
        <EmptyState>Dhan returned no strikes for this expiry.</EmptyState>
      </div>
    );
  }

  const spot = chain.last_price;
  const atm = strikes.reduce(
    (best, row, index) =>
      Math.abs(row.strike - spot) < Math.abs(strikes[best].strike - spot) ? index : best,
    0,
  );
  const visible = showAll
    ? strikes
    : strikes.slice(Math.max(0, atm - STRIKES_EACH_SIDE), atm + STRIKES_EACH_SIDE + 1);
  const maxOi = Math.max(1, ...visible.map((row) => Math.max(row.ce?.oi ?? 0, row.pe?.oi ?? 0)));
  const firstAboveSpot = visible.findIndex((row) => row.strike > spot);
  const spotAt = firstAboveSpot === -1 ? visible.length : firstAboveSpot;

  const spotRow = (
    <tr key="spot">
      <td colSpan={11} className="h-6 p-0">
        <CenterOnMount token={scrollToken} />
        <div className="flex items-center gap-2 px-3">
          <span aria-hidden className="h-px flex-1 bg-accent/50" />
          <span className="font-mono text-label text-accent">
            {underlyingName} {price.format(spot)}
          </span>
          <span aria-hidden className="h-px flex-1 bg-accent/50" />
        </div>
      </td>
    </tr>
  );

  return (
    <>
      <div
        data-scroll-container
        tabIndex={0}
        className="max-h-[calc(100dvh-16rem)] min-h-72 overflow-auto focus-visible:-outline-offset-2"
      >
        <table className="w-full min-w-[60rem] border-collapse text-body tabular-nums">
          <caption className="sr-only">{underlyingName} option chain</caption>
          <thead className="sticky top-0 z-10 bg-panel text-label tracking-wider text-muted uppercase">
            <tr className="border-b border-line">
              <th colSpan={5} scope="colgroup" className="h-7 px-3 text-center font-medium">
                Calls
              </th>
              <td aria-hidden className="bg-raised" />
              <th colSpan={5} scope="colgroup" className="h-7 px-3 text-center font-medium">
                Puts
              </th>
            </tr>
            <tr className="border-b border-line">
              {CALL_COLUMNS.map((label) => (
                <th key={`ce-${label}`} scope="col" className="h-7 px-3 text-right font-medium">
                  {label}
                </th>
              ))}
              <th scope="col" className="h-7 bg-raised px-3 text-center font-medium">
                Strike
              </th>
              {PUT_COLUMNS.map((label) => (
                <th key={`pe-${label}`} scope="col" className="h-7 px-3 text-right font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.flatMap((row, index) => {
              const callItm = row.strike < spot;
              const putItm = row.strike > spot;
              const cells = (
                <tr key={row.strike} className="border-b border-line/70 hover:bg-raised/50">
                  <OiCell leg={row.ce} maxOi={maxOi} side="call" itm={callItm} />
                  <Cell itm={callItm}>
                    <OiChange leg={row.ce} />
                  </Cell>
                  <Cell itm={callItm}>{compact(row.ce?.volume)}</Cell>
                  <Cell itm={callItm}>{iv(row.ce?.implied_volatility)}</Cell>
                  <Cell itm={callItm}>
                    <Ltp leg={row.ce} />
                  </Cell>
                  <th
                    scope="row"
                    className={`h-8 bg-raised px-3 text-center font-medium ${
                      row.strike === strikes[atm].strike ? "text-accent" : ""
                    }`}
                  >
                    {quantity.format(row.strike)}
                  </th>
                  <Cell itm={putItm}>
                    <Ltp leg={row.pe} />
                  </Cell>
                  <Cell itm={putItm}>{iv(row.pe?.implied_volatility)}</Cell>
                  <Cell itm={putItm}>{compact(row.pe?.volume)}</Cell>
                  <Cell itm={putItm}>
                    <OiChange leg={row.pe} />
                  </Cell>
                  <OiCell leg={row.pe} maxOi={maxOi} side="put" itm={putItm} />
                </tr>
              );
              return index === spotAt ? [spotRow, cells] : [cells];
            })}
            {spotAt === visible.length && spotRow}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-label text-muted">
        <span>
          {showAll
            ? `All ${strikes.length} strikes`
            : `${visible.length} of ${strikes.length} strikes around ATM`}
          {" · shaded cells are in the money"}
        </span>
        <Link href={toggleHref} className="hover:text-fg">
          {showAll ? `Show ${STRIKES_EACH_SIDE} each side of ATM` : "Show all strikes"}
        </Link>
      </div>
    </>
  );
}

function Cell({ itm, children }: { itm: boolean; children: ReactNode }) {
  return (
    <td className={`h-8 px-3 text-right whitespace-nowrap ${itm ? "bg-itm" : ""}`}>{children}</td>
  );
}

function OiCell({
  leg,
  maxOi,
  side,
  itm,
}: {
  leg?: OptionLeg;
  maxOi: number;
  side: "call" | "put";
  itm: boolean;
}) {
  const oi = leg?.oi;
  return (
    <td className={`relative h-8 px-3 text-right whitespace-nowrap ${itm ? "bg-itm" : ""}`}>
      {oi !== undefined && oi > 0 && (
        <span
          aria-hidden
          className={`absolute inset-y-1.5 ${side === "call" ? "right-0 bg-down/15" : "left-0 bg-up/15"}`}
          style={{ width: `${Math.round((oi / maxOi) * 100)}%` }}
        />
      )}
      <span className="relative">{compact(oi)}</span>
    </td>
  );
}

function OiChange({ leg }: { leg?: OptionLeg }) {
  if (!leg || !Number.isFinite(leg.oi) || !Number.isFinite(leg.previous_oi)) return "—";
  const change = leg.oi - leg.previous_oi;
  const tone = change > 0 ? "text-up" : change < 0 ? "text-down" : "text-muted";
  return <span className={tone}>{signedCompactNumber.format(change)}</span>;
}

function Ltp({ leg }: { leg?: OptionLeg }) {
  if (!leg || !Number.isFinite(leg.last_price)) return "—";
  const change =
    leg.previous_close_price > 0
      ? (leg.last_price - leg.previous_close_price) / leg.previous_close_price
      : undefined;
  return (
    <>
      <span className="font-medium">{price.format(leg.last_price)}</span>
      {change !== undefined && (
        <span
          className={`ml-1.5 inline-block min-w-12 text-label ${
            change > 0 ? "text-up" : change < 0 ? "text-down" : "text-muted"
          }`}
        >
          {percentChange.format(change)}
        </span>
      )}
    </>
  );
}

function compact(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? "—" : compactNumber.format(value);
}

function iv(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? "—" : value.toFixed(1);
}
