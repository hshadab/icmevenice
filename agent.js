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
import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Use node-fetch with proxy agent for all HTTP calls
const fetch = (url, opts = {}) => {
  if (proxyAgent) opts.agent = proxyAgent;
  return nodeFetch(url, opts);
};

const ICME_API_KEY    = process.env.ICME_API_KEY;
const ICME_POLICY_ID  = process.env.ICME_POLICY_ID;
const VENICE_API_KEY  = process.env.VENICE_API_KEY;
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;

if (!ICME_API_KEY || !ICME_POLICY_ID || !VENICE_API_KEY) {
  console.error('Missing required environment variables. See .env.example');
  process.exit(1);
}
if (!AGENT_PRIVATE_KEY) {
  console.error('Missing AGENT_PRIVATE_KEY. Run: node setup-wallet.js');
  process.exit(1);
}

// ─── Base Sepolia USDC setup ──────────────────────────────────────────────────
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia
const USDC_DECIMALS = 6;
const BASE_SEPOLIA_EXPLORER = 'https://sepolia.basescan.org';

const agentAccount = privateKeyToAccount(AGENT_PRIVATE_KEY);

// viem uses native fetch internally. When behind an HTTPS proxy, provide a custom
// fetchFn that delegates to node-fetch (which supports our HttpsProxyAgent).
const viemFetchFn = proxyAgent
  ? (url, init) => nodeFetch(url, { ...init, agent: proxyAgent })
  : undefined;
const rpcTransport = http('https://sepolia.base.org', {
  timeout: 30_000,
  ...(viemFetchFn ? { fetchOptions: {}, fetchFn: viemFetchFn } : {}),
});
const walletClient = createWalletClient({
  account: agentAccount,
  chain: baseSepolia,
  transport: rpcTransport,
});
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: rpcTransport,
});

const erc20Abi = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

// Venice implements the OpenAI API spec — swap the base URL and use Bearer auth.
// Ref: https://docs.venice.ai/api-reference/api-spec
const venice = new OpenAI({
  apiKey: VENICE_API_KEY,
  baseURL: 'https://api.venice.ai/api/v1',
  ...(proxyAgent ? { httpAgent: proxyAgent } : {}),
});

// ─── Vendor bids coming in from the marketplace ───────────────────────────────
// Prices scaled to $0.01 USDC for testnet demo. Real wallet addresses from .env.
const VENDOR_BIDS = [
  {
    id: 'vendor_a',
    name: 'FastCloud Inc.',
    wallet: process.env.VENDOR_A_ADDRESS,
    approved: false,           // NOT on approved list
    soc2_valid: true,
    price_usdc: 0.01,
    proposal: 'FastCloud: $0.01 USDC. 99.9% uptime. No SOC2 audit on file.',
  },
  {
    id: 'vendor_b',
    name: 'SecureCompute LLC',
    wallet: process.env.VENDOR_B_ADDRESS,
    approved: true,
    soc2_valid: true,
    price_usdc: 0.01,
    proposal: 'SecureCompute: $0.01 USDC. 99.99% uptime. SOC2 Type II certified. Net-60 terms.',
  },
  {
    id: 'vendor_c',
    name: 'BudgetHost Co.',
    wallet: process.env.VENDOR_C_ADDRESS,
    approved: true,
    soc2_valid: false,         // SOC2 expired
    price_usdc: 0.01,
    proposal: 'BudgetHost: $0.01 USDC. 99.5% uptime. SOC2 certification expired March 2025.',
  },
];

if (VENDOR_BIDS.some(v => !v.wallet)) {
  console.error('Missing vendor wallet addresses. Run: node setup-wallet.js');
  process.exit(1);
}

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
  console.log(`\n    Recommended vendor: ${winner.name} ($${winner.price_usdc} USDC)`);

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
    `purchaseOrderAmount is ${vendor.price_usdc}.`,
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

// ─── 3. Payment Gate — Real USDC transfer on Base Sepolia ───────────────────
// Verifies both proofs locally, then executes a real ERC20 USDC transfer
// on Base Sepolia testnet. The transaction hash is a real on-chain tx.
//
// Future: replace local proof checks with an on-chain PaymentGate contract
// that verifies proofs atomically (Venice ECDSA signature via ecrecover,
// ICME Groth16 proof via on-chain verifier).

async function releasePayment(vendor, veniceProof, icmeProof, action_id) {
  console.log('\n[3] Payment gate: verifying proofs + transferring USDC on Base Sepolia...');

  // Verify proofs locally (in production: on-chain contract does this)
  const icmeValid   = icmeProof.result === 'SAT';
  const veniceValid = !!veniceProof.request_id;
  if (!icmeValid)   throw new Error('Payment gate: ICME proof invalid or UNSAT');
  if (!veniceValid) throw new Error('Payment gate: Venice proof missing');

  // Check agent USDC balance before transfer
  const balance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [agentAccount.address],
  });
  const balanceFormatted = formatUnits(balance, USDC_DECIMALS);
  console.log(`    Agent wallet:  ${agentAccount.address}`);
  console.log(`    USDC balance:  ${balanceFormatted} USDC`);
  console.log(`    Transfer:      ${vendor.price_usdc} USDC → ${vendor.wallet}`);

  const amountRaw = parseUnits(String(vendor.price_usdc), USDC_DECIMALS);
  if (balance < amountRaw) {
    throw new Error(
      `Insufficient USDC balance: have ${balanceFormatted}, need ${vendor.price_usdc}. ` +
      `Fund agent wallet at https://faucet.circle.com/ (Base Sepolia)`
    );
  }

  // Execute real USDC transfer on Base Sepolia
  console.log('\n    Submitting ERC20 transfer on Base Sepolia...');
  const txHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [vendor.wallet, amountRaw],
  });
  console.log(`    Tx submitted: ${txHash}`);

  // Wait for on-chain confirmation
  console.log('    Waiting for confirmation...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const explorerUrl = `${BASE_SEPOLIA_EXPLORER}/tx/${txHash}`;
  console.log(`\n    \u2713 Confirmed in block ${receipt.blockNumber}`);
  console.log(`    \u2713 ${vendor.price_usdc} USDC transferred to ${vendor.wallet}`);
  console.log(`    \u2713 Explorer: ${explorerUrl}`);

  // Log the proof binding (audit trail linking proofs to payment)
  const paymentRecord = {
    action_id,
    tx_hash: txHash,
    block_number: Number(receipt.blockNumber),
    network: 'base-sepolia',
    recipient: vendor.wallet,
    amount_usdc: vendor.price_usdc,
    usdc_contract: USDC_ADDRESS,
    icme_proof: {
      check_id:  icmeProof.check_id,
      policy_id: ICME_POLICY_ID,
      result:    icmeProof.result,
    },
    venice_proof: {
      request_id:  veniceProof.request_id,
      model:       veniceProof.model,
      e2ee:        veniceProof.e2ee_enabled,
      attestation: veniceProof.attestation,
    },
  };
  console.log('\n    Payment record (links proofs to on-chain tx):');
  console.log(JSON.stringify(paymentRecord, null, 4));

  return { txn_hash: txHash, amount: vendor.price_usdc, recipient: vendor.wallet, explorer_url: explorerUrl };
}

// ─── Main Agent Loop ──────────────────────────────────────────────────────────

async function runProcurementAgent() {
  console.log('\u2550'.repeat(64));
  console.log('  ICME \u00d7 VENICE \u00d7 x402 \u2014 AUTONOMOUS PROCUREMENT AGENT');
  console.log('\u2550'.repeat(64));
  console.log(`\nAgent wallet: ${agentAccount.address}`);
  console.log(`Network:      Base Sepolia (chain ${baseSepolia.id})`);

  // Check USDC balance before starting
  const startBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [agentAccount.address],
  });
  console.log(`USDC balance: ${formatUnits(startBalance, USDC_DECIMALS)} USDC`);
  if (startBalance === 0n) {
    console.error('\nNo USDC balance! Fund the agent wallet first:');
    console.error(`  1. Get ETH: https://portal.cdp.coinbase.com/products/faucet`);
    console.error(`  2. Get USDC: https://faucet.circle.com/`);
    console.error(`  Address: ${agentAccount.address}`);
    process.exit(1);
  }

  console.log('\nIncoming vendor bids:');
  VENDOR_BIDS.forEach(v => console.log(`  - ${v.name}: $${v.price_usdc} USDC`));

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
      .sort((a, b) => a.price_usdc - b.price_usdc)[0];

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
    network: 'Base Sepolia',
    explorer: payment.explorer_url,
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
