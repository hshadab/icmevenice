// setup-wallet.js — Generate wallets for the procurement demo (Base Sepolia testnet)
//
// Creates 1 agent wallet + 3 vendor wallets. Prints addresses and funding instructions.
// Private keys are saved to .env — do NOT use these on mainnet with real funds.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';

const WALLETS = [
  { envKey: 'AGENT_PRIVATE_KEY', label: 'Agent (payer)' },
  { envKey: 'VENDOR_A_ADDRESS', label: 'Vendor A — FastCloud Inc.' },
  { envKey: 'VENDOR_B_ADDRESS', label: 'Vendor B — SecureCompute LLC' },
  { envKey: 'VENDOR_C_ADDRESS', label: 'Vendor C — BudgetHost Co.' },
];

console.log('Generating wallets for Base Sepolia testnet...\n');

const entries = [];
const addresses = {};

for (const w of WALLETS) {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  console.log(`  ${w.label}`);
  console.log(`    Address:     ${account.address}`);
  console.log(`    Private key: ${key}\n`);

  if (w.envKey === 'AGENT_PRIVATE_KEY') {
    entries.push(`${w.envKey}=${key}`);
    entries.push(`AGENT_ADDRESS=${account.address}`);
    addresses.agent = account.address;
  } else {
    entries.push(`${w.envKey}=${account.address}`);
  }
}

// Append to .env if it exists, otherwise create
const envPath = '.env';
let envContent = '';
try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch {}

// Remove old wallet entries
const cleaned = envContent
  .split('\n')
  .filter(line => !WALLETS.some(w => line.startsWith(w.envKey + '=')) && !line.startsWith('AGENT_ADDRESS='))
  .join('\n')
  .trimEnd();

const newContent = cleaned + '\n\n# Wallets (Base Sepolia testnet — do NOT use on mainnet)\n' + entries.join('\n') + '\n';
fs.writeFileSync(envPath, newContent);
console.log('Wallet keys saved to .env\n');

console.log('═'.repeat(64));
console.log('  NEXT STEPS — Fund the agent wallet');
console.log('═'.repeat(64));
console.log(`
  Agent address: ${addresses.agent}

  1. Get Base Sepolia ETH (for gas):
     https://portal.cdp.coinbase.com/products/faucet
     → Select "Base Sepolia", paste agent address

  2. Get test USDC (for payments):
     https://faucet.circle.com/
     → Select "USDC", select "Base Sepolia", paste agent address
     → You'll receive 20 USDC (we only need $0.01 per run)

  3. Run the demo:
     source .env && npm start
`);
