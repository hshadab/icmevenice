# ICME × Venice × x402 — Agentic Commerce Demo

**AI Vendor Selection Agent with Proof-Gated Payment**

## What This Does (Plain English)

Imagine you need to buy cloud computing from one of three vendors. Instead of a human comparing proposals and approving the purchase, an AI agent does it all automatically. But here's the catch — you need to *trust* that the agent did it right. This demo shows how three independent systems work together to make that possible:

1. **Venice keeps the evaluation private.** The AI scores each vendor's proposal using end-to-end encryption. This means no vendor can peek at the scoring criteria or see what their competitors bid. It's like sealing the evaluation in a tamper-proof envelope — even Venice itself can't read it.

2. **ICME enforces your company's rules.** Before any money moves, ICME checks the agent's decision against your procurement policy: Is the vendor on the approved list? Is the amount under the spending limit? Is their SOC2 certification current? If any rule is violated, the transaction is blocked — no exceptions. ICME uses three independent solvers (Z3, Automated Reasoning, and LLM) for defense-in-depth verification.

3. **x402 only releases payment when both checks pass.** The payment contract won't send a single dollar unless it receives proof from *both* Venice (the evaluation was private) and ICME (the action follows policy). No proof, no payment. No trust required.

**The bottom line:** The agent can't overspend, can't pay unapproved vendors, can't be gamed by vendors who peek at the criteria, and can't release money without cryptographic proof that everything checks out.

### A Quick Example

Three vendors bid on a cloud compute contract:

- **FastCloud** — $6,200/mo, but not on the approved vendor list
- **SecureCompute** — $8,400/mo, approved, SOC2 certified, 99.99% uptime
- **BudgetHost** — $5,100/mo, approved, but SOC2 certification expired

The agent privately scores all three. Venice recommends SecureCompute as the best option. ICME confirms the payment complies with policy (approved vendor, valid SOC2, under $25K limit). The x402 payment contract verifies both proofs and releases $8,400 USDC to SecureCompute.

If Venice had recommended BudgetHost (cheapest), ICME would have blocked it — expired SOC2 violates policy. The agent then falls back to the next compliant vendor. Neither system alone gets the right answer. Together, they do.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

You'll need:
- **ICME_API_KEY** — sign up at [icme.io](https://icme.io)
- **VENICE_API_KEY** — get one at [venice.ai/settings/api](https://venice.ai/settings/api)

### Step 1: Create the procurement policy

This compiles your plain-English rules into formal logic that ICME can check against:

```bash
source .env
npm run setup-policy
```

It will print a `policy_id` — add that to your `.env` as `ICME_POLICY_ID`.

### Step 2: Generate wallets (Base Sepolia testnet)

Creates an agent wallet and three vendor wallets. Private keys are saved to `.env`.

```bash
npm run setup-wallet
```

### Step 3: Fund the agent wallet

The agent needs Base Sepolia ETH (for gas) and test USDC (for payments). The setup script prints your agent address — paste it into these faucets:

1. **ETH for gas** — [Coinbase CDP Faucet](https://portal.cdp.coinbase.com/products/faucet) → select Base Sepolia
2. **Test USDC** — [Circle Faucet](https://faucet.circle.com/) → select USDC + Base Sepolia (gives 20 USDC, we use $0.01/run)

### Step 4: Run the agent

```bash
source .env
npm start
```

The agent will execute a **real USDC transfer** on Base Sepolia. You'll get a transaction hash and explorer link you can verify on [sepolia.basescan.org](https://sepolia.basescan.org).

## How It Works Step by Step

```
┌─────────────────────────────────────────────────────────────┐
│                     PROCUREMENT AGENT                        │
│                                                             │
│  1. Receive bids from Vendor A, B, C                        │
│              │                                              │
│              ▼                                              │
│  2. Venice E2EE inference ──────────────────────────────┐   │
│     - Prompt encrypted on device                        │   │
│     - Vendors cannot see scoring criteria               │   │
│     - Returns: recommendation + TEE attestation cert    │   │
│              │                               Venice Proof│  │
│              ▼                                          │   │
│  3. ICME Preflight check ───────────────────────────┐   │   │
│     - Values: isVendorOnApprovedList, amount, etc.  │   │   │
│     - Three solvers: Z3 + AR + LLM                  │   │   │
│     - Returns: SAT/UNSAT + check_id + zk_proof      │   │   │
│              │                          ICME Proof   │   │   │
│              ▼                               │       │   │   │
│  4. x402 Payment Gate ◄─────────────────────┘───────┘   │   │
│     - Submits BOTH proofs to payment contract           │   │
│     - Verifies proofs reference same action_id          │   │
│     - Releases $8,400 USDC to Vendor B atomically       │   │
└─────────────────────────────────────────────────────────────┘
```

1. **Vendor bids arrive** — three companies submit proposals with prices, uptime guarantees, and compliance info.
2. **Venice evaluates privately** — the agent sends all bids to Venice's encrypted AI. The prompt (including scoring weights) is encrypted on your device and only decrypted inside a secure hardware enclave. Nobody — not Venice, not the vendors — can see how the scoring works.
3. **ICME checks the rules** — the agent submits structured policy variables (`isVendorOnApprovedList`, `purchaseOrderAmount`, `isVendorSOC2CertificationExpired`, etc.) to ICME's `/v1/checkIt` endpoint. Three independent solvers verify the action:
   - **Z3** — formal SMT solver, checks satisfiability of the compiled logic
   - **AR** (Automated Reasoning) — independent translation and verification
   - **LLM** — language model cross-check
   All three must agree for a confident result. If AR is uncertain but Z3 and LLM both confirm SAT, the action is still allowed.
4. **x402 releases payment** — the payment contract receives both proofs. If and only if both are valid and reference the same decision, it releases USDC to the vendor's wallet. No human in the loop.

## ICME Policy Variables

The compiled policy exposes these formal variables (used in the action string sent to `/v1/checkIt`):

| Variable | Type | Description |
|----------|------|-------------|
| `isVendorOnApprovedList` | boolean | Vendor is on the approved vendor list |
| `isVendorSOC2CertificationExpired` | boolean | Vendor's SOC2 certification has expired |
| `purchaseOrderAmount` | number | Dollar amount of the purchase order |
| `hasDualAuthorization` | boolean | Dual authorization obtained (required for >$25K) |
| `agentAuthorizationScope` | enum | `AuthorizationScope_READ_ONLY` or `AuthorizationScope_OTHER` |
| `isPaymentApproved` | boolean | Payment has been approved |
| `isPurchaseOrderApproved` | boolean | Purchase order has been approved |

**Important:** The action string must use exact variable names (e.g., `isVendorOnApprovedList is true`) for ICME's Automated Reasoning layer to translate them correctly. Using natural language descriptions (e.g., "vendor is approved") causes AR to fail-closed.

## ICME Three-Solver Verification

ICME runs three independent verification layers on every `/v1/checkIt` call:

| Result | Meaning |
|--------|---------|
| All three SAT | Action is allowed — full confidence |
| AR uncertain, Z3 + LLM SAT | Action is allowed — AR confirmed with low confidence, local solvers unanimous |
| AR fail-closed, Z3 + LLM SAT | Action is allowed — AR couldn't translate but local solvers agree |
| Any solver UNSAT | Action is blocked |

The agent treats "AR uncertain" and "AR fail-closed" as SAT when both Z3 and LLM independently confirm. This prevents false negatives from AR translation failures while maintaining defense-in-depth.

## Why You Need All Three

| Without... | What goes wrong |
|------------|----------------|
| **Venice** | Vendors could reverse-engineer the scoring criteria and game their proposals to win unfairly. |
| **ICME** | The AI might recommend a vendor that violates your company's rules — wrong vendor list, expired certifications, over budget — and the payment goes through anyway. |
| **x402** | You have two nice proofs but no way to enforce them. Payment still depends on someone (or some code) you have to trust. The smart contract makes enforcement automatic and trustless. |

The combined guarantee: *"This payment was produced by verified private reasoning AND complies with policy — and you can prove both without trusting the agent, Venice, or ICME."*

## API Reference

- **ICME** — [docs.icme.io](https://docs.icme.io)
  - `POST /v1/makeRules` — Compile plain-English policy into formal logic (streams SSE, 300 credits)
  - `POST /v1/checkIt` — Check an action against policy (streams SSE, 1 credit). Returns `{ check_id, result, z3_result, ar_result, llm_result, detail, extracted, verification_time_ms, zk_proof_id }`
  - `POST /v1/verify` — Check structured values directly against a policy, no LLM extraction (1 credit). Request: `{ policy_id, action, values }`. Returns `{ check_id, action: "BLOCKED"|"SAT" }`
  - `POST /v1/runPolicyTests` — Run saved test cases against a compiled policy
  - `GET /v1/policy/:id/scenarios` — Get generated test scenarios for a policy
- **Venice** — [docs.venice.ai/api-reference/api-spec](https://docs.venice.ai/api-reference/api-spec)
  - OpenAI-compatible chat completions at `https://api.venice.ai/api/v1/chat/completions`
  - E2EE requires a model with `supportsE2EE: true` — check via `GET /v1/models`. The standard `venice-uncensored` does **not** support E2EE; use `e2ee-venice-uncensored-24b-p` instead
  - E2EE models don't support `response_format` — parse JSON from content directly
  - `GET /v1/tee/attestation?model=<model>&nonce=<32-byte-hex>` — returns Intel TDX quote, NVIDIA payload, signing address, and app certificate chain. Verify the nonce matches to prevent replay attacks
  - `GET /v1/tee/signature/<request_id>` — verify a response was signed by the attested enclave
  - [How Venice E2EE works](https://venice.ai/blog/venice-launches-end-to-end-encrypted-ai)
  - [TEE & E2EE models guide](https://docs.venice.ai/overview/guides/tee-e2ee-models)

## What's Real vs Simulated

| Component | Status | Details |
|-----------|--------|---------|
| Venice E2EE inference | **Real** | Live API call to `e2ee-venice-uncensored-24b-p` with `supportsE2EE: true`. Prompt encrypted on-device, decrypted only in TEE. |
| Venice TEE attestation | **Real** | Fetched via `GET /v1/tee/attestation`. Returns Intel TDX quote, NVIDIA attestation payload, signing address, and nonce verification. |
| ICME policy compilation | **Real** | `setup-policy.js` calls `POST /v1/makeRules` to compile plain-English rules into formal logic. |
| ICME policy check | **Real** | Live call to `POST /v1/checkIt`. Three independent solvers (Z3, AR, LLM) verify the action. Returns a real `zk_proof_id`. |
| USDC transfer | **Real** | ERC20 `transfer()` on Base Sepolia testnet. Real on-chain transaction with verifiable tx hash on [sepolia.basescan.org](https://sepolia.basescan.org). Uses test USDC ($0.01/run). |
| Vendor wallets | **Real** | Generated via `setup-wallet.js`. Real Base Sepolia addresses that receive USDC. |
| Vendor bids | **Simulated** | Hardcoded array in `agent.js`, not received from an external marketplace. |
| Proof verification | **Simulated** | Proof checks happen in local JS, not in an on-chain contract. Future: deploy a `PaymentGate.sol` that verifies proofs atomically via Automata DCAP (Venice TDX) and Groth16 (ICME ZK). |
| Proof binding | **Simulated** | The `action_id` links proofs to payment in the audit log, but nothing on-chain enforces this binding yet. |

## Files

| File | What it does |
|------|-------------|
| `agent.js` | The main demo — evaluates vendors, checks policy, releases payment |
| `setup-policy.js` | One-time setup — compiles your procurement rules into an ICME policy |
| `.env.example` | Template for your API keys |
