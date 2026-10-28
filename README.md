# Local Web Prototype

This repository is an internal working prototype, **not a reviewed public-release package**. It contains business-specific implementation and repository history that are not approved for release. The future public plan is to extract only a generic website shell and placeholder flow into a separate repository; private business logic and data stay in the internal library.

## Architecture

The home page is now a cross-category sourcing/creative workbench with two primary modes: `/sourcing.html` for category-and-need driven public product-detail-page research, and `/video.html` for authorized viral-reference analysis and a Hypit **handoff**. The original content editor remains at `/content.html`; video generation is not connected. See [video workbench scope and integration boundaries](docs/VIDEO-WORKBENCH.md) and [project classification](docs/PROJECT-CLASSIFICATION.md).

- `server.js` — local Node.js HTTP server, static-page delivery, and API routing.
- `public/` — multi-page HTML, CSS, and browser JavaScript.
- `lib/` — validation, provider integration, workflow, public-page research, product insight extraction, viral-reference ranking, and export modules. Some modules are internal-only.
- `test/` — Node's built-in test suite.

The general interaction pattern is **enter or import → review and confirm → run a workflow → inspect the result → export when available**. Pages are prototype surfaces; this README intentionally omits product, supplier, pricing, competitor-selection, and research-result details.

The category research path deliberately does not require supplier samples: it accepts a category, user need, English public-page queries, and optional feature hints, then returns observed PDP fields such as price, page-declared features, weight, rating, review count, visible positive/negative samples, and a clearly labelled negative-rate basis. It does not infer profit or claim that a sampled video is the platform-wide highest-played reference.

Some optional workflows make outbound requests when invoked. In particular, the current working tree includes an optional Amazon public-page research adapter; startup research is disabled by default, but user-triggered research can still make network requests. This is not an offline-only application. Model-backed operations also send the submitted content to the provider configured locally.

## Hypit upstream attribution

This project explicitly uses the Hypit upstream GitHub repository: <https://github.com/hypit-ai/hypit>.
The local validation checkout is kept separately at `E:\Projects\hypit-runtime`, and the isolated
AG68 proof project is at `E:\Projects\ag68-hypit-demo`. This repository contains the governed video
handoff and local-workflow documentation; it does not vendor Hypit's source or claim that the main
workbench has a hosted generation provider. The local proof used Hypit's media and HTML endpoints
only, with no source-media upload, paid model request, or platform publication.

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
