# Local Web Prototype

This repository is an internal working prototype, **not a reviewed public-release package**. It contains business-specific implementation and repository history that are not approved for release. The future public plan is to extract only a generic website shell and placeholder flow into a separate repository; private business logic and data stay in the internal library.

## Architecture

- `server.js` — local Node.js HTTP server, static-page delivery, and API routing.
- `public/` — multi-page HTML, CSS, and browser JavaScript.
- `lib/` — validation, provider integration, workflow, analysis, and export modules. Some modules are internal-only.
- `test/` — Node's built-in test suite.

The general interaction pattern is **enter or import → review and confirm → run a workflow → inspect the result → export when available**. Pages are prototype surfaces; this README intentionally omits product, supplier, pricing, competitor-selection, and research-result details.

Some optional workflows make outbound requests when invoked. In particular, the current working tree includes an optional Amazon public-page research adapter; startup research is disabled by default, but user-triggered research can still make network requests. This is not an offline-only application. Model-backed operations also send the submitted content to the provider configured locally.

## Run locally

Requirements: Node.js 18 or later.

```sh
npm install
npm start
```

Open <http://127.0.0.1:5178>. To use model-backed operations, copy `.env.example` to `.env.deepseek.local` and configure a key locally. Keep local credentials out of source control. Run the automated checks with:

```sh
npm test
```

## Publication boundary

Do not publish this checkout or treat its current Git history as a public release. Before any release, separately audit tracked source, tests, repository history, and licensing. A root `LICENSE` file exists, but it is not publication clearance for private business material. The separate public repository should contain only reviewed generic UI scaffolding, neutral placeholder content, and sanitized examples; internal workflows, strategies, prompts, data, and reports remain private.
