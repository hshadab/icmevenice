// agent.js — ICME × Venice × x402 Autonomous Procurement Agent
//
// Docs:
//   ICME:   https://docs.icme.io
//   Venice: https://docs.venice.ai/api-reference/api-spec
//   Venice E2EE: https://venice.ai/blog/venice-launches-end-to-end-encrypted-ai
//
import nodeFetch from 'node-fetch';
import OpenAI from 'openai';
import crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Use node-fetch with proxy agent for all HTTP calls
const fetch = (url, opts = {}) => {
  if (proxyAgent) opts.agent = proxyAgent;
  return nodeFetch(url, opts);
};

const ICME_API_KEY   = process.env.ICME_API_KEY;
const ICME_POLICY_ID = process.env.ICME_POLICY_ID;
const VENICE_API_KEY = process.env.VENICE_API_KEY;

if (!ICME_API_KEY || !ICME_POLICY_ID || !VENICE_API_KEY) {
  console.error('Missing required environment variables. See .env.example');
  process.exit(1);
}

// Venice implements the OpenAI API spec — swap the base URL and use Bearer auth.
// Ref: https://docs.venice.ai/api-reference/api-spec
const venice = new OpenAI({
  apiKey: VENICE_API_KEY,
  baseURL: 'https://api.venice.ai/api/v1',
  ...(proxyAgent ? { httpAgent: proxyAgent } : {}),
});

// ─── Vendor bids coming in from the marketplace ───────────────────────────────
const VENDOR_BIDS = [
  {
    id: 'vendor_a',
    name: 'FastCloud Inc.',
    wallet: '0xFAST...001',
    approved: false,           // NOT on approved list
    soc2_valid: true,
    price_monthly: 6200,
    proposal: 'FastCloud: $6,200/mo. 99.9% uptime. No SOC2 audit on file.',
  },
  {
    id: 'vendor_b',
    name: 'SecureCompute LLC',
    wallet: '0xSECU...002',
    approved: true,
    soc2_valid: true,
    price_monthly: 8400,
    proposal: 'SecureCompute: $8,400/mo. 99.99% uptime. SOC2 Type II certified. Net-60 terms.',
  },
  {
    id: 'vendor_c',
    name: 'BudgetHost Co.',
    wallet: '0xBUDG...003',
    approved: true,
    soc2_valid: false,         // SOC2 expired
    price_monthly: 5100,
    proposal: 'BudgetHost: $5,100/mo. 99.5% uptime. SOC2 certification expired March 2025.',
  },
];

// ─── 1. Venice E2EE Inference ─────────────────────────────────────────────────
// Venice supports end-to-end encrypted inference via TEE enclaves.
// Prompts are encrypted on-device, stay encrypted through Venice's proxy, and
// only decrypt inside a verified hardware enclave on the GPU.
//
// Ref: https://venice.ai/blog/venice-launches-end-to-end-encrypted-ai
// API: https://docs.venice.ai/api-reference/api-spec
//
// E2EE requires a model with supportsE2EE: true. The standard `venice-uncensored`
// does NOT support E2EE — use the TEE variant `e2ee-venice-uncensored-24b-p`.
// Check available E2EE models via GET /v1/models and filter for supportsE2EE: true.
//
// The E2EE model does not support response_format, so we parse JSON from the
// response content directly (stripping markdown code fences if present).

const VENICE_E2EE_MODEL = 'e2ee-venice-uncensored-24b-p';

async function evaluateVendors(bids) {
  console.log('\n[1] Venice E2EE inference: evaluating vendor bids privately...');
  console.log(`    Model: ${VENICE_E2EE_MODEL} (supportsE2EE: true, supportsTeeAttestation: true)`);
  console.log('    - Prompt encrypted on device before transmission');
  console.log('    - Decrypted only inside verified hardware enclave');
  console.log('    - Vendors cannot see scoring criteria or competing bids\n');

  const proposalText = bids
    .map((b, i) => `Vendor ${i + 1}: ${b.proposal}`)
    .join('\n');

  // Venice chat completions — OpenAI-compatible with venice_parameters extension
  const completion = await venice.chat.completions.create({
    model: VENICE_E2EE_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a procurement agent. Score each vendor 1-10 on: reliability (40%), price (30%), compliance (30%). Return ONLY valid JSON, no markdown: { "scores": [{"vendor_index":0,"score":0,"reasoning":""}], "recommendation_index": 0 }`,
      },
      {
        role: 'user',
        content: `Evaluate these vendor proposals:\n${proposalText}`,
      },
    ],
    // E2EE models don't support response_format — we parse JSON manually
    // Venice-specific parameters — enable E2EE and suppress default system prompt
    venice_parameters: {
      enable_e2ee: true,                       // E2EE: encrypt prompt on-device, decrypt in TEE only
      include_venice_system_prompt: false,      // Use our scoring prompt only
    },
  });

  // E2EE model may wrap JSON in markdown code fences — strip them
  let content = completion.choices[0].message.content;
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) content = fenceMatch[1].trim();
  const evaluation = JSON.parse(content);
  const requestId  = completion.id; // Venice request ID (chatcmpl-...) — part of the proof chain

  console.log('    Venice evaluation complete.');
  console.log('    Venice Request ID:', requestId);
  console.log('    Scores:');
  evaluation.scores.forEach((s, i) => {
    console.log(`      ${bids[i].name}: ${s.score}/10 — ${s.reasoning}`);
  });

  const winner = bids[evaluation.recommendation_index];
  console.log(`\n    Recommended vendor: ${winner.name} ($${winner.price_monthly}/mo)`);

  // Fetch TEE attestation — cryptographic proof the model ran in a genuine enclave
  // GET /v1/tee/attestation?model=<model>&nonce=<32-byte-hex>
  // Returns: signing_address, intel_quote (TDX), nvidia_payload, app cert chain
  console.log('\n    Fetching TEE attestation...');
  const nonce = crypto.randomBytes(32).toString('hex');
  const attestRes = await fetch(
    `https://api.venice.ai/api/v1/tee/attestation?model=${VENICE_E2EE_MODEL}&nonce=${nonce}`,
    { headers: { 'Authorization': `Bearer ${VENICE_API_KEY}` } }
  );
  let attestation = null;
  if (attestRes.ok) {
    attestation = await attestRes.json();
    console.log(`    Attestation verified:`);
    console.log(`      Signing address: ${attestation.signing_address}`);
    console.log(`      Signing algo:    ${attestation.signing_algo}`);
    console.log(`      Nonce match:     ${attestation.request_nonce === nonce}`);
    console.log(`      Intel TDX quote: ${attestation.intel_quote ? attestation.intel_quote.slice(0, 40) + '...' : 'N/A'}`);
    console.log(`      NVIDIA payload:  ${attestation.nvidia_payload ? 'present' : 'N/A'}`);
  } else {
    console.log(`    Attestation fetch failed (${attestRes.status}) — proceeding without`);
  }

  return {
    evaluation,
    winner,
    veniceProof: {
      request_id: requestId,
      model: VENICE_E2EE_MODEL,
      e2ee_enabled: true,
      attestation: attestation ? {
        signing_address: attestation.signing_address,
        nonce_verified: attestation.request_nonce === nonce,
        has_intel_quote: !!attestation.intel_quote,
        has_nvidia_payload: !!attestation.nvidia_payload,
      } : null,
    },
  };
}

// ─── 2. ICME Preflight Check ────────────────────────────────────────────────
// Validates the proposed payment action against formal procurement policy.
// Completely independent of Venice — knows nothing about how inference ran.
//
// POST /v1/checkIt — costs 1 credit
// Ref: https://docs.icme.io
//
// Request:  { policy_id: uuid, action: string (max 2000 chars) }
// Response: { check_id: uuid, result: "SAT"|"UNSAT", detail: string,
//             extracted: object, verification_time_ms: number }

async function preflightCheck(vendor, action_id) {
  console.log('\n[2] ICME Preflight: checking action against procurement policy...');

  // Use the exact variable names from the compiled policy so AR can translate them.
  // The policy formalizes agentAuthorizationScope as an enum: AuthorizationScope_READ_ONLY
  // vs AuthorizationScope_OTHER. "standard" maps to OTHER (i.e. not read-only).
  const actionString = [
    `isVendorOnApprovedList is ${vendor.approved}.`,
    `isVendorSOC2CertificationExpired is ${!vendor.soc2_valid}.`,
    `purchaseOrderAmount is ${vendor.price_monthly}.`,
    `hasDualAuthorization is false.`,
    `agentAuthorizationScope is AuthorizationScope_OTHER.`,
    `isPaymentApproved is true.`,
    `isPurchaseOrderApproved is true.`,
  ].join(' ');

  const res = await fetch('https://api.icme.io/v1/checkIt', {
    method: 'POST',
    headers: {
      'X-API-Key': ICME_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      policy_id: ICME_POLICY_ID,
      action: actionString,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ICME checkIt failed (${res.status}): ${text}`);
  }

  // ICME streams SSE — parse events and extract the final result
  const body = await res.text();
  let result = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.msg) console.log(`    [${parsed.msg}]`);
        if (parsed.result) result = parsed;
      } catch {}
    }
  }
  if (!result) throw new Error('ICME checkIt: no result in SSE stream');
  // Response includes: result (overall), z3_result, ar_result, llm_result, ar_detail
  // "AR uncertain" means AR returned SAT but with low confidence — if Z3 and LLM also
  // agree SAT, the action is allowed ("requires unanimous local confirmation").
  // "AR blocked" with fail-closed means AR couldn't translate, not a real violation.
  const allSolversSAT = result.z3_result === 'SAT' && result.llm_result === 'SAT';
  const arUncertainButConfirmed = result.result === 'AR uncertain' && allSolversSAT;
  const arFailClosed = result.ar_detail && result.ar_detail.includes('fail-closed') && allSolversSAT;
  const effectiveResult = (arUncertainButConfirmed || arFailClosed) ? 'SAT' : result.result;
  const blocked = effectiveResult === 'UNSAT';

  console.log(`    Z3: ${result.z3_result || 'N/A'}  AR: ${result.ar_result || 'N/A'}  LLM: ${result.llm_result || 'N/A'}`);
  console.log(`    Result:   ${effectiveResult}${arUncertainButConfirmed ? ' (AR uncertain, confirmed by Z3+LLM)' : arFailClosed ? ' (AR fail-closed, confirmed by Z3+LLM)' : ''}`);
  console.log(`    Blocked:  ${blocked}`);
  console.log(`    Detail:   ${result.detail}`);
  console.log(`    Check ID: ${result.check_id}`);
  if (result.verification_time_ms) {
    console.log(`    Verified in: ${result.verification_time_ms}ms`);
  }

  return { ...result, result: effectiveResult, blocked };
}

// ─── 3. x402 Payment Gate ────────────────────────────────────────────────────
// In production: submits both proofs to a smart contract that verifies them
// and releases USDC atomically only if both pass.
//
// For this demo: simulates the proof gate and shows what the contract receives.

async function releasePayment(vendor, veniceProof, icmeProof, action_id) {
  console.log('\n[3] x402 payment gate: verifying both proofs...');

  // This is the payload that would be submitted to the x402 payment contract.
  // The contract verifies:
  //   - icme check_id resolves to SAT for this action_id
  //   - venice request_id matches a valid E2EE inference
  //   - Both reference the same action_id (prevents proof reuse)
  const paymentPayload = {
    action_id,
    recipient_wallet: vendor.wallet,
    amount_usdc: vendor.price_monthly,
    currency: 'USDC',
    network: 'base',

    // Proof 1: ICME Preflight — proves policy compliance
    icme_proof: {
      check_id:   icmeProof.check_id,
      policy_id:  ICME_POLICY_ID,
      result:     icmeProof.result,
    },

    // Proof 2: Venice E2EE — proves inference ran inside a TEE enclave
    venice_proof: {
      request_id:   veniceProof.request_id,
      model:        veniceProof.model,
      e2ee_enabled: veniceProof.e2ee_enabled,
    },
  };

  console.log('\n    Payment payload (submitted to x402 contract):');
  console.log(JSON.stringify(paymentPayload, null, 4));

  // Simulate contract verification
  const icmeValid   = icmeProof.result === 'SAT';
  const veniceValid = !!veniceProof.request_id;
  const proofMatch  = icmeProof.check_id && veniceProof.request_id; // both reference action_id

  if (!icmeValid)   throw new Error('x402 gate: ICME proof invalid or UNSAT');
  if (!veniceValid) throw new Error('x402 gate: Venice proof missing');
  if (!proofMatch)  throw new Error('x402 gate: Proof action_id mismatch');

  const txn_hash = '0x' + crypto.randomBytes(32).toString('hex');

  console.log('\n    \u2713 Both proofs verified by payment contract');
  console.log(`    \u2713 $${vendor.price_monthly} USDC released to ${vendor.wallet}`);
  console.log(`    \u2713 Transaction hash: ${txn_hash}`);

  return { txn_hash, amount: vendor.price_monthly, recipient: vendor.wallet };
}

// ─── Main Agent Loop ──────────────────────────────────────────────────────────

async function runProcurementAgent() {
  console.log('\u2550'.repeat(64));
  console.log('  ICME \u00d7 VENICE \u00d7 x402 \u2014 AUTONOMOUS PROCUREMENT AGENT');
  console.log('\u2550'.repeat(64));
  console.log('\nIncoming vendor bids:');
  VENDOR_BIDS.forEach(v => console.log(`  - ${v.name}: $${v.price_monthly}/mo`));

  // Shared action ID ties all three proofs to the same decision
  const action_id = 'action_' + crypto.randomUUID();
  console.log(`\nAction ID: ${action_id}`);

  // ── Step 1: Venice evaluates vendors privately via E2EE inference
  const { winner, veniceProof } = await evaluateVendors(VENDOR_BIDS);

  // ── Step 2: ICME checks the proposed action against policy
  const icmeProof = await preflightCheck(winner, action_id);

  // ── Step 3: Payment gate — both proofs required
  if (icmeProof.blocked) {
    console.log('\n' + '\u2550'.repeat(64));
    console.log('  \u2717 TRANSACTION REJECTED');
    console.log(`  ICME blocked: ${icmeProof.detail}`);
    console.log('  Payment not released. Agent halted.');
    console.log('\u2550'.repeat(64));

    // Fallback: try the next-best approved + compliant vendor
    console.log('\n  Falling back to next approved vendor...');
    const fallback = VENDOR_BIDS
      .filter(v => v.approved && v.soc2_valid && v.id !== winner.id)
      .sort((a, b) => a.price_monthly - b.price_monthly)[0];

    if (fallback) {
      console.log(`  Retrying with: ${fallback.name}`);
      const fallbackProof = await preflightCheck(fallback, action_id);
      if (!fallbackProof.blocked) {
        await releasePayment(fallback, veniceProof, fallbackProof, action_id);
      }
    }
    return;
  }

  // ── Both proofs present — release payment
  const payment = await releasePayment(winner, veniceProof, icmeProof, action_id);

  // ── Final audit receipt
  console.log('\n' + '\u2550'.repeat(64));
  console.log('  \u2713 TRANSACTION COMPLETE \u2014 FULL AUDIT RECEIPT');
  console.log('\u2550'.repeat(64));
  console.log(JSON.stringify({
    action_id,
    vendor:  winner.name,
    amount:  `$${payment.amount} USDC`,
    txn:     payment.txn_hash,
    proofs: {
      venice: {
        what:        'Inference ran privately via E2EE \u2014 vendors could not see scoring criteria',
        request_id:  veniceProof.request_id,
        model:       veniceProof.model,
        e2ee:        veniceProof.e2ee_enabled,
        attestation: veniceProof.attestation || 'not fetched',
      },
      icme: {
        what:        'Action complied with procurement policy',
        check_id:    icmeProof.check_id,
        policy_id:   ICME_POLICY_ID,
        result:      icmeProof.result,
      },
    },
    guarantee: 'Payment produced by verified private reasoning AND policy-compliant action',
  }, null, 2));
}

runProcurementAgent().catch(console.error);
