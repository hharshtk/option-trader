# Predictions

How the app predicts NIFTY and grades its predictions: the **Predict** and **Grade** steps of the [constitution's](constitution.md#2-what-it-is) loop. What is built and what comes next is tracked in [roadmap.md](roadmap.md).

## Contents

1. [The prediction scoreboard](#the-prediction-scoreboard)
2. [How a minute is graded](#how-a-minute-is-graded)
3. [Reading it](#reading-it)
4. [Where it runs and what it stores](#where-it-runs-and-what-it-stores)
5. [First results](#first-results)

## The prediction scoreboard

Every predictor is graded on every minute of every recorded day, not just on the minutes it traded. A signal that trades 10 times a day still says something on the other 360 minutes; the scoreboard keeps all of it. It appears on the Pulse page, under the Signal lab.

The Signal lab grades today's signals in NIFTY points, before costs. The scoreboard grades every recorded day, in rupees from the recorded option prices, after charges, and covers the decision lab's rules and two baselines as well.

**Predictors:**

| Kind | Which | Calls |
|---|---|---|
| Baseline | Coin flip | Nothing. Its result is half a call and half a put at every minute: what guessing earns |
| Baseline | Keeps going since the open | Up while NIFTY is above its open, down while below |
| Signal | Every Pulse signal ([pulse.md](pulse.md#signal-lab)) | Up on its long vote, down on its short vote |
| Rule | Every decision lab candidate ([trading.md](trading.md#decision-lab)) | Its own call, inside its own entry window. Its daily trade cap is a trading limit, so it doesn't apply here |

## How a minute is graded

For each minute up to 14:59, the **outcome** is what followed over the next 15 minutes ([predict.ts](../src/lib/decide/predict.ts)):

- **NIFTY's move**, in points.
- **The call's and the put's result:** one lot of the at-the-money option of the nearest expiry, bought at the minute's close at the ask + ₹0.05 and sold 15 minutes later at the bid − ₹0.05, after Dhan's charges. These are the decision lab's own entry and exit rules (`entryAt`, `exitPrice` in [simulate.ts](../src/lib/decide/simulate.ts)), so a contract with a spread over 3% or a premium under ₹5 isn't bought. There's no stop and no target: the prediction is being graded, not a trading plan.

No outcome crosses 15:15, where the closing auction starts and NIFTY stops trading ([research.md](research.md#things-the-data-taught-us)).

A predictor's call is **right** when NIFTY then moved its way. It **paid** when the option on its side (the call for up, the put for down) made money after charges.

## Reading it

| Column | Means |
|---|---|
| Calls | Minutes it made a call that have an outcome, on the days that test it |
| Right way | Share of those calls after which NIFTY moved its way. Graded on every recorded day, including 16 and 17 November, which have no option prices |
| With option prices | Calls where both options could be bought and sold (from 18 November) |
| Paid | Share of those where its option made money after charges. For the coin flip, the share of single random trades that paid |
| A lot on each call | Average rupees a call, one lot, after charges |
| Coin flip, same minutes | What half a call and half a put made at exactly those minutes |
| Vs coin flip | The difference: the rupees a call that the prediction added over guessing at the same moments |
| Days ahead | Days on which it beat the coin flip, out of the days it made priced calls |

**Day by day** lists each day: how often the calls were right, and rupees a call against the coin flip. NIFTY's move that day is shown in brackets.

What to keep in mind:

- **Minutes next to each other are one idea counted several times.** A signal that votes for 10 minutes in a row is graded 10 times on overlapping outcomes. Judge it by its days, not by its count of calls.
- **An up day flatters every call.** That's why each predictor is compared with the coin flip at its own minutes, and why the day's move is shown.
- **Rules count only from the day that tests them** (their "tested from" date), and so does a signal written with days already seen: Breadth + 5-level OFI from 25 November 2026. Days they were written with show dimmed in Day by day.
- **Proof takes 20 sessions** ([constitution](constitution.md#4-principles)). Before that, the scoreboard shows where to look, not what works.

## Where it runs and what it stores

- **When:** with the decision lab, 10 minutes after each session's close (the engine runs `npm run decide` in a child process), and by hand with `npm run decide`, which also prints the scoreboard. A day is graded once its lab tables are built.
- **Tables** (Parquet in the file store, written by [lab.ts](../src/engine/decide/lab.ts)): `decide/outcomes/<date>` (each minute: `t`, `horizon`, NIFTY's `move`, `call_net`, `put_net`) and `decide/calls/<date>` (each predictor's call: `predictor`, `t`, `vote`).
- **Served** at `GET /v1/predictions` as a `PredictionView` (cached for a minute), and on the web through `/api/engine/v1/predictions`.
- **Shown** by [prediction-board.tsx](../src/components/insight/prediction-board.tsx) on the Pulse page.

## First results

Graded 19 November 2026 over four days: 16 and 17 November on direction only, 18 and 19 November with option prices. NIFTY's moves from first minute to 15:14: −75, +95, −145, +310.

| Predictor | Right way | A lot on each call | Vs coin flip | Days ahead |
|---|---|---|---|---|
| Coin flip | half | −₹93 | | |
| Keeps going since the open | 56% of 1,380 | +₹23 | +₹116 | 2 of 2 |
| Breadth thrust | 57% of 136 | +₹232 | +₹329 | 2 of 2 |
| Basket leads index | 45% of 75 | +₹954 | +₹1,014 | 2 of 2 |
| Order book lean | 61% of 460 | +₹166 | +₹253 | 1 of 2 |
| Two or more agree | 56% of 71 | +₹344 | +₹433 | 1 of 2 |
| Futures order flow | 40% of 111 | −₹227 | −₹102 | 0 of 2 |

- **Guessing loses ₹93 a minute.** Buying the at-the-money option at a random moment and selling it 15 minutes later loses about that much after charges. Options priced more movement than NIFTY delivered on both priced days.
- **"Keeps going since the open" is a real bar.** It was right 56% of the time over the four days, more on the trend days (68% on 19 November) and less on 16 November (41%).
- **Basket leads index shows why the direction-only days matter.** Its rupees on the two priced days look strong, but it was right 44% and 15% of the time on 16 and 17 November.
- **Order book lean followed the day.** It was right 44% on 18 November and 73% on 19 November.
- **Breadth thrust was the steadiest:** right 64%, 47%, 53% and 62% on the four days, and ahead of the coin flip on both priced days.

Two priced days prove nothing. These figures say where to look as the days add up.
