# Asset Allowlist Observability & Startup Configuration Signals

**Batch ID**: SSB-2026-124  
**Area**: `backend`

This document specifies the observable telemetry, startup configuration validation, and runbook procedures for the Asset Allowlist workflow (`GET /api/assets`, `GET /api/admin/assets`, `POST /api/admin/assets`, `DELETE /api/admin/assets/:code`), covering duplicate/mixed-case code normalization and structured outcome signals on startup.

---

## 1. Lifecycle Review & Boundaries

The Asset Allowlist subsystem loads and maintains the active set of token codes permitted for payment streams on StellarStream:

| Condition | Input / Event | System Behavior | Operator Classification |
|---|---|---|---|
| **Valid Configuration** | `ALLOWED_ASSETS="USDC,XLM"` | Normalizes codes, seeds unique records into `allowed_assets`. | **Success** (`outcome: "success"`, code `0`, `isNormalEmpty: false`). |
| **Duplicate Codes** | `ALLOWED_ASSETS="USDC,xlm,Usdc,XLM"` | Deduplicates to `["USDC", "XLM"]`, increments `asset_allowlist_duplicates_total`. | **Success** (`outcome: "success"`, code `0`, `duplicateCount: 2`). |
| **Mixed-case Codes** | `ALLOWED_ASSETS="yusd, euRo, testCoin "` | Trims whitespace and normalizes to uppercase: `["YUSD", "EURO", "TESTCOIN"]`. | **Success** (`outcome: "success"`, code `0`). |
| **Normal Empty Case** | Allowlist query on empty store / test baseline | Returns `data: []` without throwing 500 or failing. | **Normal empty case** (`isNormalEmpty: true`, `outcome: "success"`, code `0`). |
| **Empty Config Failure** | `ALLOWED_ASSETS=""` or whitespace-only | Fails startup validation, emits structured blocked signal. | **Configuration Failure** (`outcome: "blocked"`, code `2`, `isNormalEmpty: false`). |
| **Malformed Codes Failure** | Asset code violating 1–12 alphanumeric rule (e.g. `!@#$`, length > 12) | Fails startup validation, emits structured blocked signal with detail. | **Configuration Failure** (`outcome: "blocked"`, code `2`, `isNormalEmpty: false`). |

---

## 2. Distinguishing Normal Empty Case from Startup Failure

Operators and alerting systems must distinguish a clean/empty allowlist query from a critical startup misconfiguration:

- **Normal Empty Case**:
  - `isNormalEmpty`: `true`
  - `outcome`: `"success"` (`outcomeCode: 0`)
  - Detail: `Normal empty asset allowlist configuration.`
  - Telemetry: Prometheus outcome gauge reports `0`. No operator intervention required.

- **Startup Configuration Failure**:
  - `isNormalEmpty`: `false`
  - `outcome`: `"blocked"` (`outcomeCode: 2`)
  - Detail: `Invalid configuration on startup: ALLOWED_ASSETS must contain at least one asset code.` or `contains malformed asset codes`.
  - Telemetry: Structured warning/error emitted with `event: "asset_allowlist_config"`, Prometheus outcome gauge set to `2`. Operator action required to update environment variables.

---

## 3. Observable Signals & Telemetry

### 3.1 Prometheus Metrics

Exported via `/metrics` in `backend/src/services/metrics.ts`:

| Metric Name | Type | Description | Values / Labels |
|---|---|---|---|
| `asset_allowlist_outcome` | Gauge | Asset allowlist configuration outcome | `0=success`, `1=transient_delay`, `2=blocked` |
| `asset_allowlist_latency_ms` | Gauge | Duration in milliseconds to validate and load allowlist | Integer / Float ms |
| `asset_allowlist_duplicates_total` | Counter | Total duplicate asset codes stripped from configuration | Monotonic integer count |

### 3.2 Structured Logging

When configuration is evaluated or the allowlist endpoint is queried:

```json
{
  "level": 30,
  "event": "asset_allowlist_query",
  "outcome": "success",
  "outcomeCode": 0,
  "latencyMs": 1,
  "isNormalEmpty": false,
  "count": 2,
  "correlation_id": "a8f8e43d-a531-4e1b-89c7-aa812f58ad82",
  "requestId": "a8f8e43d-a531-4e1b-89c7-aa812f58ad82",
  "streamId": "optional-stream-id",
  "msg": "Asset allowlist queried: 2 active allowed asset(s)"
}
```

When invalid configuration is detected on startup:

```json
{
  "level": 40,
  "event": "asset_allowlist_config",
  "outcome": "blocked",
  "outcomeCode": 2,
  "detail": "Invalid configuration on startup: contains malformed asset codes alongside 1 valid asset(s).",
  "latencyMs": 0,
  "isNormalEmpty": false,
  "uniqueAssetsCount": 1,
  "duplicateCount": 0,
  "hasInvalidCodes": true,
  "msg": "Asset allowlist configuration failure: Invalid configuration on startup: contains malformed asset codes alongside 1 valid asset(s)."
}
```

### 3.3 Log Correlation & Linking

- **Request ID / Correlation ID**: Automatically linked via `correlation_id` and `requestId`.
- **Stream ID**: Can be associated via query parameter `?streamId=...` when client is querying allowed assets for a stream creation or comparison workflow.

---

## 4. Privacy & Zero-Credential Redaction

In accordance with system security standards:
- **No Wallet Secret Keys**: Secret keys matching `^S[0-9A-Z]{55}$` are prohibited and never included in outcome signals or details.
- **No Database Passwords or Admin Keys**: Signals carry only token counts, normalized code names, and execution latency.

---

## 5. Verification & Testing

Execute the test suites:
```bash
cd backend
npx vitest run src/assetAllowlistOutcome.test.ts src/assets.test.ts
```
