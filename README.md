# E-commerce Content and Operations Assistant Agent for Individual Merchants

A local, review-first content assistant that turns verified product facts into editable draft copy for Xiaohongshu, Douyin, Tmall, and Pinduoduo. It runs on your machine and talks only to the model provider you configure. It is intended for portfolio review and local experimentation, not production use.

## What it does

- Collects structured product facts: name, description, category, brand, target audience, price info, promotion info, after-sales terms, selling points, specifications, and tone.
- Accepts up to four product images (PNG/JPEG/WebP, one 2 MB maximum each) and sends them as OpenAI-compatible multimodal content.
- Requests structured, platform-specific drafts: title, body, tags, and selling points, plus model review notes and missing-info hints.
- Runs a deterministic local review layer over every generation: risky-claim scan (absolute wording, medical claims, strong promises), numeric fact checks against the supplied facts, per-platform missing-info hints, and compliance reminders.
- Lets you edit drafts, save edits to browser-local history (up to 10 sessions), restore sessions, copy one or all drafts, and export Markdown or JSON.
- Presents a dashboard-style interface (Chinese copy, dark/light theme) with step navigation, platform cards, drag-and-drop image input, a live review panel, and summary metrics.
- Binds to `127.0.0.1` only, never writes API keys or image data to disk, and keeps draft history in `localStorage`.

## What is not included

No auto-publishing, price changes, messaging, account operations, competitor or price intelligence, sales forecasting, or video generation. Generated text is a draft: always verify facts, prices, qualifications, intellectual property, and platform rules before use. The review layer is a heuristic aid, not legal, advertising, or compliance advice.

## Run locally

Requirements: Node.js 18 or later. This project has no third-party runtime dependencies.

1. Copy `.env.example` to `.env.deepseek.local`.
2. Enter your own key in `DEEPSEEK_API_KEY`. Do not commit `.env.deepseek.local`.
3. Run `npm start`.
4. Open <http://localhost:5178>. The interface is in Chinese; code and comments are in English.

The default configuration is compatible with DeepSeek's OpenAI-compatible chat-completions API:

```ini
DEEPSEEK_API_KEY=replace_with_your_own_key
DEEPSEEK_MODEL=deepseek-flash
# Optional: an OpenAI-compatible vision model used only when images are attached.
# Leave empty to send images to DEEPSEEK_MODEL. If the model rejects images, the API returns vision_unsupported.
DEEPSEEK_VISION_MODEL=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_TIMEOUT_MS=60000
PORT=5178
```

Set `PORT=0` to let the operating system choose a free port; the server prints the port it bound to.

Configuration precedence is: values supplied by the parent process, then `.env.deepseek.local`, then a legacy `.env`. Within each layer, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_VISION_MODEL`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_TIMEOUT_MS` take precedence over compatible `AI_API_KEY`, `AI_MODEL`, `AI_VISION_MODEL`, `AI_BASE_URL`, and `AI_TIMEOUT_MS` names. `DEEPSEEK_TIMEOUT_MS` is the per-request provider timeout in milliseconds (default `60000`); a two-platform `deepseek-flash` generation was measured at roughly 20 seconds, so allow headroom for slower reasoning models. Never paste a key into source code, tests, issues, screenshots, or commits.

The server sends the product text, structured facts, and any selected images to the third-party provider you configure. Images are held in memory for that one request only: they are never written to disk and never saved to browser history. Recent draft sessions, including form data and drafts but not images, are stored in your browser until you clear them. Review that provider's terms, data handling, and pricing before use. Do not enter trade secrets, personal data, or information you are not authorized to share. This assistant should not be exposed directly to the public internet.

## API

- `GET /api/health` reports whether a usable API key is configured and whether a vision model is configured; it never returns the key.
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

## Review layer limits

- The risky-claim scan is regex-based: it catches known absolute, medical, and strong-promise wording but cannot judge context.
- Numeric fact checks compare number strings against the supplied facts; they can miss Chinese numerals and unit mismatches, and they only report `needs_review`, never "safe".
- Missing-info hints come from templates keyed by platform and are intentionally conservative.
- Images are sent with the configured model; if the provider rejects them the API returns `vision_unsupported`. Configure `DEEPSEEK_VISION_MODEL` for a vision-capable model, or remove the images.

## Project layout

```
server.js        HTTP server, static files, routing
lib/env.js       environment files, precedence, ports and timeouts
lib/validate.js  request validation and image checks
lib/prompt.js    system prompt and message construction
lib/normalize.js model output parsing and normalization
lib/review.js    risk scan, fact checks, missing info, compliance reminders
lib/provider.js  provider call, error mapping, response assembly
public/          Chinese single-page interface (no build step)
test/            node:test unit and integration suites
```

## Tests

The suite uses Node's built-in `node:test` runner, so there are no extra dependencies.

```sh
npm test
```

The unit tests cover validation rules, image checks, output normalization, review rules, prompt building, and env parsing. Integration tests start the real server against a mock OpenAI-compatible provider and cover configuration precedence, structured and multimodal requests, provider errors and timeouts, malformed model output, review output, static file serving, directory-traversal rejection, and unsupported methods.

## Roadmap

Later stages may add product discovery, competitor and price intelligence, and reviewed publishing workflows. None of those are implemented here, and nothing in this repository publishes content or changes prices automatically.

## Contributing and security

Small, reproducible issues and pull requests are welcome. Please do not include keys, customer data, private prompts, or non-public business information in an issue. Report potential security problems privately to the repository owner rather than posting sensitive details publicly.

Licensed under the [MIT License](LICENSE).
