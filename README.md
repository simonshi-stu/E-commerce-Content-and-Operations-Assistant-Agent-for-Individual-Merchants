# E-commerce Content and Operations Assistant Agent for Individual Merchants

A local, review-first content assistant that turns verified product facts into editable draft copy for Xiaohongshu, Douyin, Tmall, and Pinduoduo. It runs on your machine and talks only to the model provider you configure. It is intended for portfolio review and local experimentation, not production use.

## What it does

- Collects structured product facts: name, description, category, brand, target audience, price info, promotion info, after-sales terms, selling points, specifications, and tone.
- Accepts up to four product images (PNG/JPEG/WebP, one 2 MB maximum each) and sends them as OpenAI-compatible multimodal content.
- Requests structured, platform-specific drafts: title, body, tags, and selling points, plus model review notes and missing-info hints.
- Runs a deterministic local review layer over every generation: risky-claim scan (absolute wording, medical claims, strong promises), numeric fact checks against the supplied facts, per-platform missing-info hints, and compliance reminders.
- Lets you edit drafts, save edits to browser-local history (up to 10 sessions), restore sessions, copy one or all drafts, and export Markdown, JSON, or a per-platform publish pack for manual publishing.
- Presents a dashboard-style interface with Chinese/English switching, a three-mode theme (dark / light / follow system), step navigation, platform cards, drag-and-drop image input, a live review panel, and summary metrics.
- Provides a second local page for Stage 2 workflows: candidate product scoring, competitor comparison, and price-band analysis based on data you enter manually.
- Supports Amazon (North America) listings alongside the domestic platforms, with English listing guidance (keyword title, five bullets, information-dense description).
- Fetches live exchange rates from keyless public endpoints (`open.er-api.com` with a `frankfurter.app` fallback and a one-hour cache) and calculates multi-currency pricing: product cost and first-leg shipping in the cost currency, fulfillment and ad costs in the payout currency, referral fees, break-even price, suggested price, and profit at the planned price.
- Assesses a pasted candidate list in one pass (CSV, tab-separated, or Excel copy-paste) and ranks products by verdict, margin, score, break-even price, and confidence, with optional AI review.
- Analyses market recon records from public front ends (search results, rankings): competitor density, top-3 brand share, dominant sellers, price bands and spread, review barriers, purchase-signal floors, feature and aesthetic keywords, and an entry-difficulty score with reason codes.
- Lists public research sources (Amazon US Best Sellers and New Releases, AMZ123 top keywords, Google Trends) for manual checks. It never scrapes platforms and never opens seller backends.
- Scores data provenance: every competitor or price entry carries a source type, source note, and observation date; the app returns per-entry credibility, an aggregate credibility score, a competitor credibility ranking, reason codes, and a confidence score for every conclusion it gives.
- Draws a price timeline from dated price points, with series trends, overall trend, volatility, date range, and an inline SVG chart.
- Lets you import price data by pasting CSV or spreadsheet rows (date, platform, label, price, type, source, note) and save reusable scoring templates per category.
- Optionally sends the structured intelligence result to the configured model for an AI review that follows the same credibility contract (`skills/data-credibility/SKILL.md`) and must return its own confidence score.
- Binds to `127.0.0.1` only, never writes API keys or image data to disk, and keeps draft history in `localStorage`.

## What is not included

No auto-publishing, price changes, messaging, account operations, platform scraping, sales-data feeds, seller-backend automation, competitor or price intelligence feeds, sales forecasting, or video generation. Amazon sales data must come from an official API or a tool export that you import manually; the sourcing, competitor, and price panels only compute on data you enter. Generated text is a draft: always verify facts, prices, qualifications, intellectual property, and platform rules before use. The review layer is a heuristic aid, not legal, advertising, or compliance advice.

## Run locally

Requirements: Node.js 18 or later. This project has no third-party runtime dependencies.

1. Copy `.env.example` to `.env.deepseek.local`.
2. Enter your own key in `DEEPSEEK_API_KEY`. Do not commit `.env.deepseek.local`.
3. Run `npm start`.
4. Open <http://localhost:5178>. Switch the interface language between Chinese and English in the top bar, and choose dark, light, or follow-system theme there too.
5. Open <http://localhost:5178/intel.html> for the local sourcing, competitor, and price analysis page. It runs without a provider key.

The default configuration is compatible with DeepSeek's OpenAI-compatible chat-completions API:

```ini
DEEPSEEK_API_KEY=replace_with_your_own_key
DEEPSEEK_MODEL=deepseek-flash
# Optional: an OpenAI-compatible vision model used only when images are attached.
# Leave empty to send images to DEEPSEEK_MODEL. If the model rejects images, the API returns vision_unsupported.
DEEPSEEK_VISION_MODEL=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_TIMEOUT_MS=60000
FX_BASE_URL=https://open.er-api.com/v6/latest
FX_FALLBACK_URL=https://api.frankfurter.app/latest
FX_TIMEOUT_MS=10000
FX_CACHE_TTL_MS=3600000
PORT=5178
```

Set `PORT=0` to let the operating system choose a free port; the server prints the port it bound to.

Configuration precedence is: values supplied by the parent process, then `.env.deepseek.local`, then a legacy `.env`. Within each layer, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_VISION_MODEL`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_TIMEOUT_MS` take precedence over compatible `AI_API_KEY`, `AI_MODEL`, `AI_VISION_MODEL`, `AI_BASE_URL`, and `AI_TIMEOUT_MS` names. `DEEPSEEK_TIMEOUT_MS` is the per-request provider timeout in milliseconds (default `60000`); a two-platform `deepseek-flash` generation was measured at roughly 20 seconds, so allow headroom for slower reasoning models. Never paste a key into source code, tests, issues, screenshots, or commits.

The server sends the product text, structured facts, and any selected images to the third-party provider you configure. Recent draft sessions, including form data and drafts but not images, are stored in your browser until you clear them. Exchange-rate requests only send a currency code to the keyless public provider you configure; no product or account data is included. Review those providers' terms, data handling, and pricing before use. Do not enter trade secrets, personal data, or information you are not authorized to share. This assistant should not be exposed directly to the public internet.

## API

- `GET /api/health` reports whether a usable API key is configured and whether a vision model is configured; it never returns the key.
- `GET /api/fx?base=USD` returns live reference rates from the configured keyless provider, with a fallback provider and a one-hour cache. Only the base currency code is sent.
- `POST /api/generate` accepts the product fields plus `platforms` and optional `images`, then returns structured drafts and the review result.

Request fields:

| Field | Required | Notes |
| --- | --- | --- |
| `productName` | yes | max 200 characters |
| `productDescription` | yes | max 4000 characters |
| `platforms` | yes | one or more of `Xiaohongshu`, `Douyin`, `Tmall`, `Pinduoduo` |
| `tone` | no | max 120 characters |
| `category`, `brand` | no | max 80 characters each |
| `targetAudience` | no | max 200 characters |
| `priceInfo` | no | max 120 characters |
| `promotionInfo`, `afterSales` | no | max 200 characters each |
| `sellingPoints` | no | up to 8 strings, 160 characters each |
| `specifications` | no | up to 20 `{ "name": string, "value": string }` pairs |
| `images` | no | up to 4 `{ "name", "mimeType", "dataBase64" }` objects; PNG/JPEG/WebP; 2 MB decoded per image |

Example request:

```json
{
  "productName": "316 stainless-steel tumbler 500ml",
  "productDescription": "One-touch lid, 500ml capacity, 320g net weight, suitable for commuting.",
  "platforms": ["Xiaohongshu", "Douyin"],
  "tone": "clear and friendly",
  "priceInfo": "69 CNY regular, 49 CNY promo",
  "sellingPoints": ["24-hour heat retention", "316 stainless-steel liner"],
  "specifications": [{ "name": "Capacity", "value": "500ml" }],
  "images": []
}
```

Response shape:

```json
{
  "data": {
    "drafts": [
      {
        "platform": "Xiaohongshu",
        "title": "string",
        "body": "string",
        "tags": ["string"],
        "sellingPoints": ["string"],
        "reviewNotes": ["string"],
        "missingInfo": ["string"]
      }
    ],
    "review": {
      "missingInfo": ["string"],
      "riskWarnings": [{ "platform": "string", "term": "string", "excerpt": "string", "reason": "string", "severity": "high" }],
      "factChecks": [{ "claim": "string", "status": "needs_review", "note": "string" }],
      "complianceReminders": ["string"],
      "coverage": { "requested": ["string"], "returned": ["string"] }
    }
  },
  "meta": { "provider": "deepseek", "model": "deepseek-flash", "vision": false, "usedImages": 0 }
}
```

Error codes: `validation`, `too_large`, `provider_not_configured`, `provider_error`, `provider_rejected`, `vision_unsupported`, `invalid_model_output`, `provider_unavailable`.

### Local intelligence endpoints (no provider key needed)

- `POST /api/intel/score` computes margin metrics and a weighted candidate score, plus a confidence score derived from the declared data basis (verified / estimated / guess) and observation date.
- `POST /api/intel/compare` computes competitor price statistics, your price position, selling-point gaps, differentiators, per-entry credibility, a credibility ranking, aggregate data credibility, and conclusion confidence.
- `POST /api/intel/prices` computes a price band (min, max, average, median, P25, P75, standard deviation), break-even price, suggested price, per-entry credibility, aggregate credibility, confidence, and a dated price `timeline` with per-series trend, volatility, and chart bounds.
- `POST /api/intel/import` parses pasted CSV or tab-separated rows into price points with provenance; headers are optional and both English and Chinese source/type values are accepted.
- `POST /api/intel/pricing` converts product cost and first-leg shipping from the cost currency and fulfillment/ad costs from the payout currency, then returns per-unit costs, fixed cost, break-even price, suggested price for the target margin, and profit at the planned price.
- `POST /api/intel/batch` parses a pasted candidate list and returns a ranked assessment (verdict, margin, score, break-even, confidence) plus summary counts.
- `POST /api/intel/market` parses pasted public front-end records (keyword, position, title, brand, price, rating, reviews, bought signal, badge, note) and returns brand distribution, dominant sellers, price bands, review and rating barriers, demand floors, feature keywords, and an entry score with reason codes.

Accepted input formats for pasted data: CSV, tab-separated values, and cells copied directly from Excel. Headers are optional and support English and Chinese aliases. PDF or image lists are not parsed locally: export them as CSV, paste the text, or send product images to a configured vision model one product at a time.
- `POST /api/intel/interpret` (requires a provider key) sends the structured result to the model with the credibility contract and returns a review with its own confidence score, caveats, and recommendations.

Competitor and price entries accept `sourceType`, `sourceNote`, and `observedAt`; supported source types are `official_store`, `merchant_record`, `platform_search`, `third_party_tool`, `screenshot_note`, and `unknown`. Fresh official or personal-record data (within 30 days) scores highest; unknown or stale data is capped below "high". The full contract, weights, reason codes, and prompt block live in [`skills/data-credibility/SKILL.md`](skills/data-credibility/SKILL.md).

Example scoring request:

```json
{
  "name": "Insulated tumbler",
  "price": 100,
  "unitCost": 30,
  "shippingCost": 10,
  "platformFeeRate": 5,
  "adCostPerUnit": 5,
  "targetMarginRate": 30,
  "demand": 4,
  "competition": 3,
  "differentiation": 4,
  "risk": 2
}
```

The score response contains `metrics` (platform fee, gross profit, margin rate, break-even price), five component `scores`, `totalScore`, and a `verdict` of `recommended`, `watch`, or `avoid`. Every endpoint accepts an optional `locale` of `zh` or `en`; validation messages follow it.

## Review layer limits

- The risky-claim scan is regex-based and covers Chinese and English wording: it catches known absolute, medical, and strong-promise wording but cannot judge context.
- Numeric fact checks compare number strings against the supplied facts; they can miss Chinese numerals and unit mismatches, and they only report `needs_review`, never "safe".
- Selling-point gap analysis normalises phrases by punctuation and lowercase, so wording variants may not match exactly.
- Missing-info hints come from templates keyed by platform and are intentionally conservative.
- Images are sent with the configured model; if the provider rejects them the API returns `vision_unsupported`. Configure `DEEPSEEK_VISION_MODEL` for a vision-capable model, or remove the images.

## Project layout

```
server.js             HTTP server, static files, routing
lib/env.js            environment files, precedence, ports and timeouts
lib/messages.js       zh/en dictionaries for validation, review, and provider messages
lib/validate.js       request validation and image checks
lib/prompt.js         bilingual system prompts and message construction
lib/normalize.js      model output parsing and normalization
lib/review.js         risk scan, fact checks, missing info, compliance reminders
lib/intel.js          product scoring, competitor comparison, price statistics
lib/timeline.js       dated price series, trends, volatility, chart bounds
lib/csv.js            CSV and tab-separated price import with provenance
lib/fx.js             keyless exchange-rate fetch, fallback provider, and cache
lib/pricing.js        multi-currency cost conversion and pricing math
lib/candidates.js     batch candidate parsing and ranked assessment
lib/market.js         market recon parsing, brands, bands, barriers, entry score
lib/credibility.js    source weights, freshness, credibility and confidence scoring
lib/provider.js       provider call, error mapping, response assembly
public/index.html     content studio page
public/app.js         content studio logic
public/intel.html     local sourcing, competitor, and price analysis page
public/intel.js       intelligence page logic
public/i18n.js        zh/en UI dictionaries and static text binding
public/styles.css     shared design system (dark/light)
skills/data-credibility/SKILL.md   versioned credibility contract for code and model prompts
test/                 node:test unit and integration suites
```

## Tests

The suite uses Node's built-in `node:test` runner, so there are no extra dependencies.

```sh
npm test
```

The unit tests cover validation rules, image checks, output normalization, review rules, bilingual messages, prompt building, env parsing, credibility scoring, intel calculators, intel review normalization, price timelines, CSV import parsing, batch candidate assessment, market recon analysis, exchange-rate parsing and caching, multi-currency pricing, Amazon platform guidance, and frontend script syntax. Integration tests start the real server against a mock OpenAI-compatible provider and cover configuration precedence, structured and multimodal requests, provider errors and timeouts, malformed model output, review output, English and Amazon generation, the local intelligence endpoints (including provenance, credibility, timelines, pricing, imports, batch assessment, and market recon), the exchange-rate endpoint, static file serving, directory-traversal rejection, and unsupported methods. The suite currently contains 108 tests.

## Roadmap

The current focus is North America Amazon alongside the domestic platforms. Stage 3 is implemented locally: candidate product scoring with reusable category templates, competitor comparison, price-band analysis with an SVG price timeline, CSV import for data you own, multi-currency pricing and shipping with live rates, Amazon listing generation, provenance and credibility scoring, an optional AI review with its own confidence score, and a manual publish pack that you review before publishing by hand. The credibility contract is versioned (`CREDIBILITY_VERSION`) and documented as a reusable skill. Sales and keyword data must come from public rankings, Google Trends, an official API, or a paid tool export that you import manually; this repository never scrapes platforms or touches seller backends. Possible later stages include full intel dataset import/export and category-level keyword templates. Nothing in this repository publishes content, changes prices, or operates accounts automatically.

## Contributing and security

Small, reproducible issues and pull requests are welcome. Please do not include keys, customer data, private prompts, or non-public business information in an issue. Report potential security problems privately to the repository owner rather than posting sensitive details publicly.

Licensed under the [MIT License](LICENSE).
