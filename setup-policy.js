// setup-policy.js — Compile the procurement policy via ICME
import fetch from 'node-fetch';

const ICME_API_KEY = process.env.ICME_API_KEY;

if (!ICME_API_KEY) {
  console.error('Error: ICME_API_KEY environment variable is required.');
  process.exit(1);
}

async function setupPolicy() {
  console.log('Creating procurement policy via ICME...\n');

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

  const result = await res.json();
  console.log('Policy created successfully!\n');
  console.log('Response:', JSON.stringify(result, null, 2));
  console.log(`\nSet this in your environment:\n  export ICME_POLICY_ID=${result.policy_id}`);
}

setupPolicy().catch(console.error);
