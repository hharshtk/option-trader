// Try the OpenRouter decisions API on a listing + image.
// Usage: node --env-file-if-exists=.env.local scripts/decision-demo.ts [image.png]
import fs from "node:fs";
import { OpenRouter } from "@openrouter/sdk";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (put it in .env.local)");

const imagePath = process.argv[2] ?? "image.png";
const imageBase64 = (await fs.promises.readFile(imagePath)).toString("base64");

const openrouter = new OpenRouter({ apiKey });

// The model answers narrow, typed questions about the state. Your code owns the workflow.
const decision = await openrouter.alpha.decisions.create({
  decisionsRequest: {
    model: "perplexity/pplx-decider-v1.3:free",
    state: [
      "Listing: vintage red bicycle, light scratches on the frame",
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
    ],
    questions: {
      matches_listing: {
        type: "noul",
        instructions: "Does the attached media show the listed item?",
        criteria: {
          true: "The listed item is shown",
          false: "Something else or nothing is shown",
        },
      },
      category: {
        type: "choice",
        instructions: "Which category fits this listing?",
        criteria: {
          bikes: "Complete bicycles",
          parts: "Components and accessories",
          apparel: "Clothing and gear",
        },
      },
      condition: {
        type: "score",
        instructions: "How worn is the item?",
        criteria: ["Like new", "Light wear", "Heavy wear"],
      },
    },
  },
});

const { matches_listing, category, condition } = decision.answers;
if (matches_listing.type === "noul" && category.type === "choice" && condition.type === "score") {
  // noul is a probability from 0 (no) to 1 (yes); choice and score carry the full distribution.
  console.log("matches_listing:", matches_listing.noul);
  console.log("category:", category.choice, category.probabilities);
  console.log("condition:", condition.score, condition.probabilities);
  const publish = matches_listing.noul > 0.8 && category.choice === "bikes";
  console.log("publish?", publish);
} else {
  console.log(JSON.stringify(decision, null, 2));
}
