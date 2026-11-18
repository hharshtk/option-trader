// Test the Liquid decisions API (systemone): send a few support tickets, check each answer is well-formed
// and lands where expected, and report latency, tokens and cost.
//
// Usage:
//   node --env-file-if-exists=.env.local scripts/liquid-decision-test.ts                 # run the built-in cases
//   node --env-file-if-exists=.env.local scripts/liquid-decision-test.ts "Some ticket"   # ask about your own text
//   flags: --model <id> (default d1.2-ultra), --raw (print the full JSON response)
//
// Needs LIQUID_API_KEY. Exits 1 if any request fails or any check fails.

export {}; // a module, so top-level await works and these names don't clash with globals

const ENDPOINT = "https://api.liquid.ai/decisions/v1/systemone";
const INPUT_USD_PER_MTOK = 0.042; // output tokens are free

const apiKey = process.env.LIQUID_API_KEY;
if (!apiKey) {
  console.error("LIQUID_API_KEY is not set (put it in .env.local)");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const model = flag("--model") ?? "d1.2-ultra";
const rawAt = args.indexOf("--raw");
const raw = rawAt !== -1;
if (raw) args.splice(rawAt, 1);
const customState = args.join(" ").trim();

const questions = {
  department: {
    type: "choice",
    instructions: "Which team should handle this?",
    criteria: {
      billing: "Payments, invoicing, refunds",
      technical: "Bugs, outages, integrations",
      sales: "Pricing, upgrades, new accounts",
    },
  },
  is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
  frustration: {
    type: "score",
    instructions: "How frustrated is the customer?",
    criteria: ["Calm", "Frustrated", "Very angry"],
  },
} as const;

type Expect = { department?: string; urgent?: boolean; frustration?: "low" | "high" };
type Case = { name: string; state: string; expect: Expect };

const cases: Case[] = customState
  ? [{ name: "custom", state: customState, expect: {} }]
  : [
      {
        name: "failing payouts",
        state: "Help! My payouts have been failing for 3 days.",
        expect: { department: "billing", urgent: true },
      },
      {
        name: "upgrade question",
        state: "Hi there, could you tell me what the annual plan costs compared to monthly? No rush.",
        expect: { department: "sales", urgent: false, frustration: "low" },
      },
      {
        name: "outage rant",
        state: "Your API has returned 500s ALL MORNING and our checkout is completely down. This is unacceptable!!!",
        expect: { department: "technical", urgent: true, frustration: "high" },
      },
    ];

type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
  | { type: "noul"; noul: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence?: number;
    };
type Decision = {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number; cost: number };
};

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// Shape checks: every question answered with its own type, probabilities that add up, and a cost that
// matches the published price.
function checkShape(r: Decision): string[] {
  const fails: string[] = [];
  for (const [key, q] of Object.entries(questions)) {
    const a = r.answers?.[key];
    if (!a) { fails.push(`${key}: missing`); continue; }
    if (a.type !== q.type) { fails.push(`${key}: type ${a.type}, asked for ${q.type}`); continue; }
    if (a.type === "choice" && q.type === "choice") {
      const options = Object.keys(q.criteria);
      if (!options.includes(a.choice)) fails.push(`${key}: choice "${a.choice}" is not an option`);
      if (Object.keys(a.probabilities).sort().join() !== [...options].sort().join())
        fails.push(`${key}: probabilities do not cover exactly the options`);
      if (!near(sum(Object.values(a.probabilities)), 1)) fails.push(`${key}: probabilities sum to ${sum(Object.values(a.probabilities))}`);
      const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0][0];
      if (top !== a.choice) fails.push(`${key}: choice "${a.choice}" is not the most likely ("${top}")`);
    }
    if (a.type === "noul" && !(a.noul >= 0 && a.noul <= 1)) fails.push(`${key}: noul ${a.noul} outside 0..1`);
    if (a.type === "score" && q.type === "score") {
      const p = q.criteria.map((_, i) => a.probabilities[String(i)]);
      if (p.some((x) => typeof x !== "number")) fails.push(`${key}: probabilities missing a level`);
      else {
        if (!near(sum(p), 1)) fails.push(`${key}: probabilities sum to ${sum(p)}`);
        const expected = sum(p.map((x, i) => x * i));
        if (!near(a.score, expected)) fails.push(`${key}: score ${a.score} is not the expected level ${expected}`);
      }
      q.criteria.forEach((label, i) => {
        if (a.legend?.[String(i)] !== label) fails.push(`${key}: legend[${i}] is "${a.legend?.[String(i)]}", sent "${label}"`);
      });
    }
  }
  const u = r.usage;
  if (!u) fails.push("usage: missing");
  else {
    if (u.output_tokens !== 0) fails.push(`usage: ${u.output_tokens} output tokens (expected 0)`);
    const expectedCost = (u.input_tokens * INPUT_USD_PER_MTOK) / 1e6;
    if (!near(u.cost, expectedCost, 1e-9)) fails.push(`usage: cost $${u.cost}, price says $${expectedCost}`);
  }
  return fails;
}

// Answer checks: did the model land where a person would?
function checkExpect(r: Decision, e: Expect): string[] {
  const fails: string[] = [];
  const { department, is_urgent, frustration } = r.answers;
  if (e.department && department?.type === "choice" && department.choice !== e.department)
    fails.push(`department: got ${department.choice}, expected ${e.department}`);
  if (e.urgent !== undefined && is_urgent?.type === "noul" && is_urgent.noul > 0.5 !== e.urgent)
    fails.push(`is_urgent: got ${pct(is_urgent.noul)}, expected ${e.urgent ? "yes" : "no"}`);
  if (e.frustration && frustration?.type === "score") {
    const ok = e.frustration === "low" ? frustration.score < 0.75 : frustration.score > 1;
    if (!ok) fails.push(`frustration: got ${frustration.score.toFixed(2)}, expected ${e.frustration}`);
  }
  return fails;
}

function describe(r: Decision): string[] {
  const lines: string[] = [];
  for (const [key, a] of Object.entries(r.answers ?? {})) {
    if (a.type === "choice") {
      const dist = Object.entries(a.probabilities).map(([k, v]) => `${k} ${pct(v)}`).join(", ");
      lines.push(`${key}: ${a.choice}  (${dist})`);
    } else if (a.type === "noul") {
      lines.push(`${key}: ${pct(a.noul)} yes`);
    } else if (a.type === "score") {
      const dist = Object.entries(a.probabilities).map(([k, v]) => `${a.legend?.[k] ?? k} ${pct(v)}`).join(", ");
      lines.push(`${key}: ${a.score.toFixed(2)}  (${dist})`);
    }
  }
  return lines;
}

let failed = 0;
let totalCost = 0;
let totalTokens = 0;

for (const c of cases) {
  console.log(`\n▶ ${c.name}: "${c.state}"`);
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: c.state, questions }),
    });
  } catch (err) {
    console.log(`  ✗ request failed: ${(err as Error).message}`);
    failed++;
    continue;
  }
  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) {
    console.log(`  ✗ HTTP ${res.status} after ${ms} ms: ${text.slice(0, 500)}`);
    failed++;
    continue;
  }
  let body: Decision;
  try {
    body = JSON.parse(text);
  } catch {
    console.log(`  ✗ response is not JSON: ${text.slice(0, 500)}`);
    failed++;
    continue;
  }
  if (raw) console.log(JSON.stringify(body, null, 2));
  for (const line of describe(body)) console.log(`  ${line}`);

  const u = body.usage;
  if (u) {
    totalCost += u.cost;
    totalTokens += u.input_tokens;
  }
  console.log(`  ${ms} ms · model ${body.model} · ${u?.input_tokens ?? "?"} input tokens · $${u?.cost.toFixed(9) ?? "?"}`);

  const fails = [...checkShape(body), ...checkExpect(body, c.expect)];
  if (fails.length) {
    failed++;
    for (const f of fails) console.log(`  ✗ ${f}`);
  } else {
    console.log("  ✓ all checks passed");
  }
}

const perMillionRequests = cases.length && totalCost ? (totalCost / cases.length) * 1e6 : 0;
console.log(
  `\n${cases.length - failed}/${cases.length} cases passed · ${totalTokens} input tokens · $${totalCost.toFixed(9)} total` +
    (perMillionRequests ? ` (≈ $${perMillionRequests.toFixed(2)} per million requests like these)` : ""),
);
process.exit(failed ? 1 : 0);
