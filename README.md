# E-commerce Content and Operations Assistant Agent for Individual Merchants

A small, local demo that turns a product description into editable draft copy for selected platforms. It is intended for portfolio review and local experimentation, not production use.

## What it does

- Collects a product name, description, tone, and one or more target platforms.
- Sends the text to a model provider configured by you.
- Requests structured, platform-specific copy drafts.
- Lets you copy an editable draft, then keeps up to ten recent local draft sessions in your browser for viewing or restoring.

## What is not included

This public demo does **not** include product discovery, sales/ROI/margin forecasting, real-time competitor or price intelligence, advertising automation, price changes, publishing automation, account permissions, private prompts, internal workflow designs, data connectors, or video generation.

Generated text is a draft. You must review facts, product claims, price, compliance requirements, intellectual-property rights, and platform rules before using it. Do not treat the output as business, legal, advertising, or platform-policy advice.

## Run locally

Requirements: Node.js 18 or later. This project has no third-party runtime dependencies.

1. Copy `.env.example` to `.env.deepseek.local`.
2. Enter your own key in `DEEPSEEK_API_KEY`. Do not commit `.env.deepseek.local`.
3. Run `npm start`.
4. Open <http://localhost:5178>.

The default configuration is compatible with DeepSeek's OpenAI-compatible chat-completions API:

```ini
DEEPSEEK_API_KEY=replace_with_your_own_key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_TIMEOUT_MS=15000
PORT=5178
```

Set `PORT=0` to let the operating system choose a free port; the server prints the port it bound to.

Configuration precedence is: values supplied by the parent process, then `.env.deepseek.local`, then a legacy `.env`. Within each layer, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_TIMEOUT_MS` take precedence over compatible `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`, and `AI_TIMEOUT_MS` names. The generic `AI_*` names remain supported for compatibility. `DEEPSEEK_TIMEOUT_MS` is the per-request provider timeout in milliseconds (default `15000`); raise it if you point `DEEPSEEK_MODEL` at a slower reasoning model. Never paste a key into source code, issues, screenshots, or commits.

The server sends the product text you enter to the third-party provider you configure. Recent local sessions, including form data and drafts, are stored in your browser until you clear them. Review that provider's terms, data handling, and pricing before use. Do not enter trade secrets, personal data, or information you are not authorized to share. This demo should not be exposed directly to the public internet.

## API

- `GET /api/health` reports whether a usable API key is configured; it never returns the key.
- `POST /api/generate` accepts `productName`, `productDescription`, `platforms`, and optional `tone`, then returns structured drafts.

Example request:

```json
{
  "productName": "Insulated tumbler",
  "productDescription": "A stainless-steel tumbler for daily drinks.",
  "platforms": ["Xiaohongshu", "Douyin"],
  "tone": "clear and friendly"
}
```

## Tests

The suite uses Node's built-in `node:test` runner, so there are no extra dependencies.

```sh
npm test
```

Each test starts the real server against a mock OpenAI-compatible provider. The suite covers configuration precedence and defaults, request validation, provider error and timeout handling, malformed model output, static file serving, directory-traversal rejection, and unsupported methods.

## Contributing and security

Small, reproducible issues and pull requests are welcome. Please do not include keys, customer data, private prompts, or non-public business information in an issue. Report potential security problems privately to the repository owner rather than posting sensitive details publicly.

Licensed under the [MIT License](LICENSE).
