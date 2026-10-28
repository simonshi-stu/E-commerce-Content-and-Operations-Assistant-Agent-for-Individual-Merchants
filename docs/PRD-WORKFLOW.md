# PRD workflow and acceptance rules

This document describes the implementation contract for a new workflow. It is a design document, not a claim that every listed capability is live.

## 1. Define the smallest useful outcome

Write the user decision the feature must support, then list P0 behavior and explicit non-goals. A P0 must have a visible result, a recoverable failure state, and a testable privacy boundary.

## 2. Freeze the data contract

Every persisted or exported business field should declare:

- identity and scope: project, brand, market, product, SKU, and configuration;
- value, unit, currency, and observed/entered time;
- source reference and license/permission basis;
- fact type: observed, user-confirmed, assumption, estimate, or inference;
- confirmation and supersession state;
- whether it is allowed in internal or external output.

Unknown values stay unknown. A user-confirmed estimate remains an estimate.

## 3. Specify gates before implementation

Define validation, authorization, budget, idempotency, path, privacy, and review gates before adding a connector or export. External calls need bounded retries and a stable operation identity. Exports need a fixed schema and a redacted profile; a file existing on disk is not sufficient acceptance evidence.

## 4. Implement one vertical slice

Start with:

```text
input -> normalize -> confirm -> execute -> persist evidence -> review -> export
```

Do not add RAG, multi-agent routing, or live integrations until the contract, evidence lineage, and failure behavior are stable.

## 5. Validate with synthetic data

The public test suite uses synthetic identifiers, URLs, contacts, costs, and observations. Tests should cover both the happy path and refusal paths, including:

- missing or conflicting identity;
- wrong scope or stale version;
- path traversal and unsafe URL redirects;
- missing unit/currency/source/time;
- duplicate operation and retry behavior;
- formula injection and external-profile redaction;
- database reopen, export read-back, and review-gate enforcement.

Temporary files belong in the operating system temporary directory or an ignored runtime directory. Data-bearing fixtures must not be committed.

## 6. Review and release

Before a change is published:

1. run the relevant tests;
2. inspect the staged file list and diff check;
3. scan for paths, keys, personal information, real source identifiers, and data files;
4. verify the README and scope docs do not overstate capability;
5. record any live or manual verification separately from fixture results.

Live evidence is optional for code-only changes and must never be simulated by a fixture.
