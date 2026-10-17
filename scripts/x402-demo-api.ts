import 'dotenv/config';
import { createServer } from 'node:http';
import { createPublicClient, http, parseEther, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';

/**
 * A tiny x402-style paid API for the demo: GET /premium-quote answers 402 with
 * a price until the caller proves payment with an `x-payment: <txHash>` header
 * pointing at a confirmed Base Sepolia transfer to X402_PAY_TO.
 *
 * Run it in one terminal:            npm run x402:api
 * Then point the agent at it:        X402_API_URL=http://127.0.0.1:8790 in .env
 * and ask the agent:                 "fetch the premium market quote"
 */

const PORT = Number(process.env.X402_PORT ?? 8790);
const PRICE_ETH = process.env.X402_PRICE ?? '0.0002';
const PAY_TO = process.env.X402_PAY_TO;

if (!PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
  console.error('Set X402_PAY_TO to the 0x address that receives the payments (e.g. an allowlisted demo address).');
  process.exit(1);
}

const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL || undefined) });
const price = parseEther(PRICE_ETH);

function paymentRequired(resource: string) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        asset: 'ETH',
        payTo: PAY_TO,
        maxAmountRequired: price.toString(),
        resource,
        description: 'Agent Vault premium market snapshot (demo data, testnet only)',
        maxTimeoutSeconds: 300,
      },
    ],
  };
}

/** True when the tx hash proves a confirmed transfer of >= price to PAY_TO. */
async function verifyPayment(txHash: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return 'x-payment must be a tx hash.';
  try {
    const [receipt, tx] = await Promise.all([
      client.getTransactionReceipt({ hash: txHash as Hex }),
      client.getTransaction({ hash: txHash as Hex }),
    ]);
    if (receipt.status !== 'success') return 'the payment transaction reverted.';
    if ((tx.to ?? '').toLowerCase() !== PAY_TO!.toLowerCase()) return 'the payment went to a different address.';
    if (tx.value < price) return `the payment was below ${PRICE_ETH} ETH.`;
    return null;
  } catch {
    return 'the payment transaction is not confirmed on Base Sepolia yet.';
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };

  if (req.method !== 'GET' || url.pathname !== '/premium-quote') {
    return send(404, { error: 'Only GET /premium-quote exists.' });
  }

  const proof = req.headers['x-payment'];
  if (typeof proof === 'string') {
    const problem = await verifyPayment(proof);
    if (problem) {
      console.log(`402 again: ${problem} (proof ${proof.slice(0, 12)}…)`);
      return send(402, { ...paymentRequired(url.pathname), error: problem });
    }
    const block = await client.getBlockNumber();
    const blockData = await client.getBlock({ blockNumber: block });
    console.log(`200 paid via ${proof.slice(0, 12)}… (block ${block})`);
    return send(200, {
      report: 'Premium market snapshot (demo data, not financial advice)',
      chain: 'Base Sepolia',
      blockNumber: block.toString(),
      blockTime: new Date(Number(blockData.timestamp) * 1000).toISOString(),
      ethUsd: '2500.00',
      gasPriceGwei: (Number(await client.getGasPrice()) / 1e9).toFixed(3),
      note: 'Demo content served by scripts/x402-demo-api.ts after an on-chain payment.',
    });
  }

  console.log('402 payment required (no x-payment header)');
  return send(402, paymentRequired(url.pathname));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`x402 demo API on http://127.0.0.1:${PORT}/premium-quote`);
  console.log(`price ${PRICE_ETH} ETH to ${PAY_TO} — set X402_API_URL=http://127.0.0.1:${PORT} for the agent`);
});
