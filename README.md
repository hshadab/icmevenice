# ICME × Venice × x402 — Agentic Commerce Demo

**AI Vendor Selection Agent with Proof-Gated Payment**

An autonomous AI agent evaluates competing vendor bids for cloud compute and executes payment to the winning vendor — without human approval. Three things must be independently true before payment releases:

1. **Venice (privacy):** The vendor evaluation was conducted privately — vendors cannot see each other's bids or the agent's scoring criteria during inference.
2. **ICME (policy):** The selected action complies with procurement policy — spend limit, approved vendor list, authorization scope.
3. **x402 (payment):** USDC releases to the vendor atomically only when both proofs are presented together and reference the same action.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

### 1. Create procurement policy

```bash
source .env
npm run setup-policy
```

Save the returned `policy_id` as `ICME_POLICY_ID` in your `.env`.

### 2. Run the agent

```bash
source .env
npm start
```

## Architecture

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
│     - Action: "Pay $8,400 to Vendor B"              │   │   │
│     - Policy: spend limit, vendor list, scope       │   │   │
│     - Returns: SAT/UNSAT + check_id                 │   │   │
│              │                          ICME Proof   │   │   │
│              ▼                               │       │   │   │
│  4. x402 Payment Gate ◄─────────────────────┘───────┘   │   │
│     - Submits BOTH proofs to payment contract           │   │
│     - Verifies proofs reference same action_id          │   │
│     - Releases $8,400 USDC to Vendor B atomically       │   │
└─────────────────────────────────────────────────────────────┘
```

## Why Each Layer Is Non-Redundant

| Layer | Unique contribution |
|-------|-------------------|
| **Venice** | E2EE — vendor can't game the evaluation by seeing scoring criteria |
| **ICME** | Spend limit and vendor approval enforced in formal logic |
| **x402** | Payment is conditional on both proofs — no off-chain trust |

**Without Venice:** Vendors could game the evaluation by probing scoring criteria.
**Without ICME:** Policy-violating actions proceed unchecked.
**Without x402:** Both proofs exist but payment release requires off-chain trust.
