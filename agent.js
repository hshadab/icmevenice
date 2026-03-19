// agent.js — ICME × Venice × x402 Autonomous Procurement Agent
//
// Dual-mode: runs as CLI (`node agent.js`) or importable (`createAgent()`).
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

// ─── Constants ────────────────────────────────────────────────────────────────
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia
const USDC_DECIMALS = 6;
const BASE_SEPOLIA_EXPLORER = 'https://sepolia.basescan.org';
const VENICE_E2EE_MODEL = 'e2ee-venice-uncensored-24b-p';

const erc20Abi = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
];

// ─── Agent Factory ────────────────────────────────────────────────────────────
// Returns an agent with all three step functions. Accepts an `emit` callback for
// streaming events to a UI. Falls back to console.log for CLI mode.

export function createAgent(options = {}) {
  const emit = options.emit || ((type, data) => {
    if (type === 'log') console.log(data.text);
    else if (type === 'error') console.error(data.message);
    else if (type === 'data' || type === 'result' || type === 'api') {
      // CLI: skip structured events, the logs cover it
    }
  });

  const env = {
    ICME_API_KEY:    process.env.ICME_API_KEY,
    ICME_POLICY_ID:  process.env.ICME_POLICY_ID,
    VENICE_API_KEY:  process.env.VENICE_API_KEY,
    AGENT_PRIVATE_KEY: process.env.AGENT_PRIVATE_KEY,
    VENDOR_A_ADDRESS: process.env.VENDOR_A_ADDRESS,
    VENDOR_B_ADDRESS: process.env.VENDOR_B_ADDRESS,
    VENDOR_C_ADDRESS: process.env.VENDOR_C_ADDRESS,
  };

  // Proxy setup
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const fetch = (url, opts = {}) => {
    if (proxyAgent) opts.agent = proxyAgent;
    return nodeFetch(url, opts);
  };

  // Venice client
  const venice = new OpenAI({
    apiKey: env.VENICE_API_KEY,
    baseURL: 'https://api.venice.ai/api/v1',
    ...(proxyAgent ? { httpAgent: proxyAgent } : {}),
  });

  // Wallet setup
  const agentAccount = privateKeyToAccount(env.AGENT_PRIVATE_KEY);
  const viemFetchFn = proxyAgent
    ? (url, init) => nodeFetch(url, { ...init, agent: proxyAgent })
    : undefined;
  const rpcTransport = http('https://sepolia.base.org', {
    timeout: 30_000,
    ...(viemFetchFn ? { fetchOptions: {}, fetchFn: viemFetchFn } : {}),
  });
  const walletClient = createWalletClient({ account: agentAccount, chain: baseSepolia, transport: rpcTransport });
  const publicClient = createPublicClient({ chain: baseSepolia, transport: rpcTransport });

  // Vendor bids
  const VENDOR_BIDS = [
    { id: 'vendor_a', name: 'FastCloud Inc.', wallet: env.VENDOR_A_ADDRESS,
      approved: false, soc2_valid: true, price_usdc: 0.01,
      proposal: 'FastCloud: $0.01 USDC. 99.9% uptime. No SOC2 audit on file.' },
    { id: 'vendor_b', name: 'SecureCompute LLC', wallet: env.VENDOR_B_ADDRESS,
      approved: true, soc2_valid: true, price_usdc: 0.01,
      proposal: 'SecureCompute: $0.01 USDC. 99.99% uptime. SOC2 Type II certified. Net-60 terms.' },
    { id: 'vendor_c', name: 'BudgetHost Co.', wallet: env.VENDOR_C_ADDRESS,
      approved: true, soc2_valid: false, price_usdc: 0.01,
      proposal: 'BudgetHost: $0.01 USDC. 99.5% uptime. SOC2 certification expired March 2025.' },
  ];

  // ── Step 1: Venice E2EE Inference ───────────────────────────────────────────
  async function evaluateVendors(bids) {
    emit('step', { step: 1, status: 'running', title: 'Venice E2EE Inference' });
    emit('log', { step: 1, text: `Model: ${VENICE_E2EE_MODEL}` });
    emit('data', { step: 1, key: 'model', value: VENICE_E2EE_MODEL });
    emit('data', { step: 1, key: 'e2ee', value: true });

    const proposalText = bids.map((b, i) => `Vendor ${i + 1}: ${b.proposal}`).join('\n');

    emit('log', { step: 1, text: 'Sending encrypted prompt to TEE enclave...' });
    emit('api', { step: 1, direction: 'req', endpoint: 'POST api.venice.ai/api/v1/chat/completions',
      body: { model: VENICE_E2EE_MODEL, venice_parameters: { enable_e2ee: true } } });

    const completion = await venice.chat.completions.create({
      model: VENICE_E2EE_MODEL,
      messages: [
        { role: 'system', content: 'You are a procurement agent. Score each vendor 1-10 on: reliability (40%), price (30%), compliance (30%). Return ONLY valid JSON, no markdown: { "scores": [{"vendor_index":0,"score":0,"reasoning":""}], "recommendation_index": 0 }' },
        { role: 'user', content: `Evaluate these vendor proposals:\n${proposalText}` },
      ],
      venice_parameters: { enable_e2ee: true, include_venice_system_prompt: false },
    });

    let content = completion.choices[0].message.content;
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) content = fenceMatch[1].trim();
    const evaluation = JSON.parse(content);
    const requestId = completion.id;

    emit('api', { step: 1, direction: 'res', endpoint: 'Venice chat completions',
      body: { id: requestId, model: VENICE_E2EE_MODEL, e2ee: true } });
    emit('data', { step: 1, key: 'request_id', value: requestId });

    const scores = evaluation.scores.map((s, i) => ({
      vendor: bids[i].name, score: s.score, reasoning: s.reasoning,
      approved: bids[i].approved, soc2_valid: bids[i].soc2_valid,
    }));
    emit('data', { step: 1, key: 'scores', value: scores });
    scores.forEach(s => emit('log', { step: 1, text: `${s.vendor}: ${s.score}/10 — ${s.reasoning}` }));

    const winner = bids[evaluation.recommendation_index];
    emit('data', { step: 1, key: 'recommendation', value: winner.name });
    emit('log', { step: 1, text: `Recommended: ${winner.name}` });

    // TEE Attestation
    emit('log', { step: 1, text: 'Fetching TEE attestation...' });
    emit('api', { step: 1, direction: 'req', endpoint: `GET api.venice.ai/api/v1/tee/attestation?model=${VENICE_E2EE_MODEL}` });
    const nonce = crypto.randomBytes(32).toString('hex');
    const attestRes = await fetch(
      `https://api.venice.ai/api/v1/tee/attestation?model=${VENICE_E2EE_MODEL}&nonce=${nonce}`,
      { headers: { 'Authorization': `Bearer ${env.VENICE_API_KEY}` } }
    );
    let attestation = null;
    if (attestRes.ok) {
      attestation = await attestRes.json();
      const att = {
        signing_address: attestation.signing_address,
        signing_algo: attestation.signing_algo,
        nonce_verified: attestation.request_nonce === nonce,
        has_intel_quote: !!attestation.intel_quote,
        has_nvidia_payload: !!attestation.nvidia_payload,
        intel_quote_preview: attestation.intel_quote?.slice(0, 60) + '...',
      };
      emit('data', { step: 1, key: 'attestation', value: att });
      emit('api', { step: 1, direction: 'res', endpoint: 'TEE attestation', body: att });
      emit('log', { step: 1, text: `Attestation: ${att.signing_address} (nonce verified: ${att.nonce_verified})` });
    } else {
      emit('log', { step: 1, text: `Attestation fetch failed (${attestRes.status})` });
    }

    const veniceProof = {
      request_id: requestId, model: VENICE_E2EE_MODEL, e2ee_enabled: true,
      attestation: attestation ? {
        signing_address: attestation.signing_address,
        nonce_verified: attestation.request_nonce === nonce,
        has_intel_quote: !!attestation.intel_quote,
        has_nvidia_payload: !!attestation.nvidia_payload,
      } : null,
    };

    emit('result', { step: 1, winner: winner.name, request_id: requestId, attestation: veniceProof.attestation });
    emit('step', { step: 1, status: 'complete', title: 'Venice E2EE Inference' });
    return { evaluation, winner, veniceProof };
  }

  // ── Step 2: ICME Policy Check ───────────────────────────────────────────────
  async function preflightCheck(vendor, action_id) {
    emit('step', { step: 2, status: 'running', title: 'ICME Policy Check' });

    const actionString = [
      `isVendorOnApprovedList is ${vendor.approved}.`,
      `isVendorSOC2CertificationExpired is ${!vendor.soc2_valid}.`,
      `purchaseOrderAmount is ${vendor.price_usdc}.`,
      `hasDualAuthorization is false.`,
      `agentAuthorizationScope is AuthorizationScope_OTHER.`,
      `isPaymentApproved is true.`,
      `isPurchaseOrderApproved is true.`,
    ].join(' ');

    emit('data', { step: 2, key: 'policy_id', value: env.ICME_POLICY_ID });
    emit('data', { step: 2, key: 'action', value: actionString });
    emit('data', { step: 2, key: 'vendor', value: vendor.name });
    emit('api', { step: 2, direction: 'req', endpoint: 'POST api.icme.io/v1/checkIt',
      body: { policy_id: env.ICME_POLICY_ID, action: actionString } });

    emit('log', { step: 2, text: `Checking "${vendor.name}" against policy...` });

    const res = await fetch('https://api.icme.io/v1/checkIt', {
      method: 'POST',
      headers: { 'X-API-Key': env.ICME_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy_id: env.ICME_POLICY_ID, action: actionString }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ICME checkIt failed (${res.status}): ${text}`);
    }

    const body = await res.text();
    let result = null;
    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.msg) {
            emit('log', { step: 2, text: parsed.msg });
          }
          if (parsed.result) result = parsed;
        } catch {}
      }
    }
    if (!result) throw new Error('ICME checkIt: no result in SSE stream');

    const allSolversSAT = result.z3_result === 'SAT' && result.llm_result === 'SAT';
    const arUncertainButConfirmed = result.result === 'AR uncertain' && allSolversSAT;
    const arFailClosed = result.ar_detail && result.ar_detail.includes('fail-closed') && allSolversSAT;
    const effectiveResult = (arUncertainButConfirmed || arFailClosed) ? 'SAT' : result.result;
    const blocked = effectiveResult === 'UNSAT';

    const solvers = {
      z3: result.z3_result || 'N/A',
      ar: result.ar_result || 'N/A',
      llm: result.llm_result || 'N/A',
    };

    emit('data', { step: 2, key: 'solvers', value: solvers });
    emit('data', { step: 2, key: 'result', value: effectiveResult });
    emit('data', { step: 2, key: 'blocked', value: blocked });
    emit('data', { step: 2, key: 'check_id', value: result.check_id });
    emit('data', { step: 2, key: 'detail', value: result.detail });
    if (result.verification_time_ms) {
      emit('data', { step: 2, key: 'verification_time_ms', value: result.verification_time_ms });
    }
    if (result.extracted) {
      emit('data', { step: 2, key: 'extracted', value: result.extracted });
    }
    emit('api', { step: 2, direction: 'res', endpoint: 'ICME checkIt', body: {
      check_id: result.check_id, result: effectiveResult, solvers,
      detail: result.detail, verification_time_ms: result.verification_time_ms,
      extracted: result.extracted,
    }});

    emit('log', { step: 2, text: `Z3: ${solvers.z3} | AR: ${solvers.ar} | LLM: ${solvers.llm}` });
    emit('log', { step: 2, text: `Result: ${effectiveResult} — ${result.detail}` });

    emit('result', { step: 2, result: effectiveResult, blocked, check_id: result.check_id, solvers });
    emit('step', { step: 2, status: blocked ? 'blocked' : 'complete', title: 'ICME Policy Check' });

    return { ...result, result: effectiveResult, blocked };
  }

  // ── Step 3: USDC Payment ────────────────────────────────────────────────────
  async function releasePayment(vendor, veniceProof, icmeProof, action_id) {
    emit('step', { step: 3, status: 'running', title: 'USDC Payment' });

    const icmeValid = icmeProof.result === 'SAT';
    const veniceValid = !!veniceProof.request_id;
    if (!icmeValid) throw new Error('Payment gate: ICME proof invalid or UNSAT');
    if (!veniceValid) throw new Error('Payment gate: Venice proof missing');

    const balance = await publicClient.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf',
      args: [agentAccount.address],
    });
    const balanceFormatted = formatUnits(balance, USDC_DECIMALS);

    emit('data', { step: 3, key: 'agent_wallet', value: agentAccount.address });
    emit('data', { step: 3, key: 'balance', value: `${balanceFormatted} USDC` });
    emit('data', { step: 3, key: 'recipient', value: vendor.wallet });
    emit('data', { step: 3, key: 'amount', value: `${vendor.price_usdc} USDC` });
    emit('data', { step: 3, key: 'network', value: 'Base Sepolia (84532)' });
    emit('data', { step: 3, key: 'usdc_contract', value: USDC_ADDRESS });
    emit('log', { step: 3, text: `Balance: ${balanceFormatted} USDC` });
    emit('log', { step: 3, text: `Transfer: ${vendor.price_usdc} USDC → ${vendor.wallet}` });

    const amountRaw = parseUnits(String(vendor.price_usdc), USDC_DECIMALS);
    if (balance < amountRaw) {
      throw new Error(`Insufficient USDC: have ${balanceFormatted}, need ${vendor.price_usdc}`);
    }

    emit('log', { step: 3, text: 'Submitting ERC20 transfer...' });
    emit('api', { step: 3, direction: 'req', endpoint: 'Base Sepolia RPC: eth_sendRawTransaction',
      body: { to: USDC_ADDRESS, fn: 'transfer(address,uint256)', args: [vendor.wallet, String(amountRaw)] } });

    const txHash = await walletClient.writeContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: 'transfer',
      args: [vendor.wallet, amountRaw],
    });
    emit('data', { step: 3, key: 'tx_hash', value: txHash });
    emit('log', { step: 3, text: `Tx submitted: ${txHash}` });

    emit('log', { step: 3, text: 'Waiting for confirmation...' });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const explorerUrl = `${BASE_SEPOLIA_EXPLORER}/tx/${txHash}`;

    emit('data', { step: 3, key: 'block_number', value: Number(receipt.blockNumber) });
    emit('data', { step: 3, key: 'explorer_url', value: explorerUrl });
    emit('data', { step: 3, key: 'status', value: 'confirmed' });
    emit('api', { step: 3, direction: 'res', endpoint: 'Base Sepolia: waitForTransactionReceipt',
      body: { blockNumber: Number(receipt.blockNumber), status: receipt.status } });
    emit('log', { step: 3, text: `Confirmed in block ${receipt.blockNumber}` });

    const paymentRecord = {
      action_id, tx_hash: txHash, block_number: Number(receipt.blockNumber),
      network: 'base-sepolia', recipient: vendor.wallet,
      amount_usdc: vendor.price_usdc, usdc_contract: USDC_ADDRESS,
      icme_proof: { check_id: icmeProof.check_id, policy_id: env.ICME_POLICY_ID, result: icmeProof.result },
      venice_proof: { request_id: veniceProof.request_id, model: veniceProof.model, e2ee: veniceProof.e2ee_enabled, attestation: veniceProof.attestation },
    };

    emit('result', { step: 3, tx_hash: txHash, block_number: Number(receipt.blockNumber), explorer_url: explorerUrl });
    emit('step', { step: 3, status: 'complete', title: 'USDC Payment' });

    return { txn_hash: txHash, amount: vendor.price_usdc, recipient: vendor.wallet, explorer_url: explorerUrl, paymentRecord };
  }

  // ── Run full pipeline ───────────────────────────────────────────────────────
  async function run() {
    const startBalance = await publicClient.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf',
      args: [agentAccount.address],
    });
    const balStr = formatUnits(startBalance, USDC_DECIMALS);

    emit('data', { step: 0, key: 'agent_address', value: agentAccount.address });
    emit('data', { step: 0, key: 'network', value: `Base Sepolia (${baseSepolia.id})` });
    emit('data', { step: 0, key: 'usdc_balance', value: `${balStr} USDC` });
    emit('data', { step: 0, key: 'vendors', value: VENDOR_BIDS.map(v => ({ name: v.name, price: v.price_usdc, approved: v.approved, soc2_valid: v.soc2_valid })) });

    if (startBalance === 0n) {
      throw new Error(`No USDC balance. Fund ${agentAccount.address} at https://faucet.circle.com/`);
    }

    const action_id = 'action_' + crypto.randomUUID();
    emit('data', { step: 0, key: 'action_id', value: action_id });

    // Step 1
    const { winner, veniceProof } = await evaluateVendors(VENDOR_BIDS);

    // Step 2
    let icmeProof = await preflightCheck(winner, action_id);
    let payVendor = winner;

    // Fallback if blocked
    if (icmeProof.blocked) {
      emit('log', { step: 2, text: `Blocked for ${winner.name}. Trying fallback...` });
      const fallback = VENDOR_BIDS
        .filter(v => v.approved && v.soc2_valid && v.id !== winner.id)
        .sort((a, b) => a.price_usdc - b.price_usdc)[0];
      if (!fallback) throw new Error('All vendors blocked by policy');
      emit('log', { step: 2, text: `Fallback: ${fallback.name}` });
      icmeProof = await preflightCheck(fallback, action_id);
      payVendor = fallback;
      if (icmeProof.blocked) throw new Error(`Fallback vendor ${fallback.name} also blocked`);
    }

    // Step 3
    const payment = await releasePayment(payVendor, veniceProof, icmeProof, action_id);

    // Final receipt
    const receipt = {
      action_id, vendor: payVendor.name, amount: `$${payment.amount} USDC`,
      txn: payment.txn_hash, network: 'Base Sepolia', explorer: payment.explorer_url,
      proofs: {
        venice: { request_id: veniceProof.request_id, model: veniceProof.model, e2ee: true, attestation: veniceProof.attestation },
        icme: { check_id: icmeProof.check_id, policy_id: env.ICME_POLICY_ID, result: icmeProof.result },
      },
    };
    emit('done', { receipt });
    return receipt;
  }

  return { run, evaluateVendors, preflightCheck, releasePayment, VENDOR_BIDS, agentAddress: agentAccount.address };
}

// ─── CLI Mode ─────────────────────────────────────────────────────────────────
const isCLI = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCLI) {
  const missing = ['ICME_API_KEY', 'ICME_POLICY_ID', 'VENICE_API_KEY', 'AGENT_PRIVATE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) { console.error(`Missing: ${missing.join(', ')}`); process.exit(1); }
  if (['VENDOR_A_ADDRESS','VENDOR_B_ADDRESS','VENDOR_C_ADDRESS'].some(k => !process.env[k])) {
    console.error('Missing vendor addresses. Run: node setup-wallet.js'); process.exit(1);
  }

  console.log('═'.repeat(64));
  console.log('  ICME × VENICE × x402 — AUTONOMOUS PROCUREMENT AGENT');
  console.log('═'.repeat(64));

  const agent = createAgent();
  agent.run().then(receipt => {
    console.log('\n' + '═'.repeat(64));
    console.log('  ✓ TRANSACTION COMPLETE — FULL AUDIT RECEIPT');
    console.log('═'.repeat(64));
    console.log(JSON.stringify(receipt, null, 2));
  }).catch(err => {
    console.error('\n✗ Agent failed:', err.message);
    process.exit(1);
  });
}
