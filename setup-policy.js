// setup-policy.js — Compile the procurement policy via ICME
// Docs: https://docs.icme.io
//
// POST /v1/makeRules streams SSE events. The final event contains the policy_id.
// Costs 300 credits.
import fetch from 'node-fetch';

const ICME_API_KEY = process.env.ICME_API_KEY;

if (!ICME_API_KEY) {
  console.error('Error: ICME_API_KEY environment variable is required.');
  process.exit(1);
}

async function setupPolicy() {
  console.log('Creating procurement policy via ICME (streams via SSE)...\n');

  const res = await fetch('https://api.icme.io/v1/makeRules', {
    method: 'POST',
    headers: {
      'X-API-Key': ICME_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      policy:
        'Never approve payment to a vendor not on the approved vendor list. ' +
        'Never approve a purchase order exceeding $25,000 without dual authorization. ' +
        'Never approve payment if the agent authorization scope is read-only. ' +
        'Never approve payment if the vendor SOC2 certification is expired.',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`ICME API error (${res.status}):`, text);
    process.exit(1);
  }

  // makeRules streams SSE — collect all events to find the final result
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    // Parse SSE stream
    const body = await res.text();
    const lines = body.split('\n');
    let lastData = null;

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          lastData = JSON.parse(data);
          // Print progress events
          if (lastData.status) {
            console.log(`  [${lastData.status}] ${lastData.message || ''}`);
          }
        } catch {
          // Non-JSON SSE line, print as-is
          console.log('  ', data);
        }
      }
    }

    if (lastData && lastData.policy_id) {
      console.log('\nPolicy compiled successfully!');
      console.log('Policy ID:', lastData.policy_id);
      if (lastData.rule_count) console.log('Rules:', lastData.rule_count);
      if (lastData.scenarios) {
        console.log('\nGenerated test scenarios:');
        lastData.scenarios.forEach((s, i) => {
          console.log(`  ${i + 1}. ${s.description} — expected: ${s.expected_result || s.expected}`);
        });
      }
      console.log(`\nSet this in your environment:`);
      console.log(`  export ICME_POLICY_ID=${lastData.policy_id}`);
    } else {
      console.log('\nFull response:', JSON.stringify(lastData, null, 2));
    }
  } else {
    // Non-streaming JSON response (fallback)
    const result = await res.json();
    console.log('Policy created successfully!\n');
    console.log('Response:', JSON.stringify(result, null, 2));
    if (result.policy_id) {
      console.log(`\nSet this in your environment:\n  export ICME_POLICY_ID=${result.policy_id}`);
    }
  }
}

setupPolicy().catch(console.error);
