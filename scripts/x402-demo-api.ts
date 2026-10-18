import 'dotenv/config';
import { createServer } from 'node:http';
import { createPublicClient, http, parseEther, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { decodePayment } from '../src/x402.js';

/**
 * A tiny x402 v2 paid API for the demo: GET /premium-quote answers 402 with a
 * price until the caller proves payment in the `X-PAYMENT` header. The proof may
 * be a v2 base64 `PaymentPayload` (what the client sends) or a bare tx hash.
 * A confirmed Base Sepolia transfer to X402_PAY_TO of at least the price unlocks
 * the data; a broadcast-but-unconfirmed transfer answers 402 with
 * `settlement_pending`, which the client must not retry.
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
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        asset: 'ETH',
        payTo: PAY_TO,
        amount: price.toString(),
        resource,
        description: 'Agent Vault premium market snapshot (demo data, testnet only)',
        maxTimeoutSeconds: 300,
      },
    ],
  };
}

type VerifyResult = { ok: true } | { ok: false; pending?: boolean; problem: string };

/** True when the tx hash proves a confirmed transfer of >= price to PAY_TO. */
async function verifyPayment(txHash: string): Promise<VerifyResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, problem: 'the payment proof carried no tx hash.' };
  try {
    const [receipt, tx] = await Promise.all([
      client.getTransactionReceipt({ hash: txHash as Hex }),
      client.getTransaction({ hash: txHash as Hex }),
    ]);
    if (receipt.status !== 'success') return { ok: false, problem: 'the payment transaction reverted.' };
    if ((tx.to ?? '').toLowerCase() !== PAY_TO!.toLowerCase()) return { ok: false, problem: 'the payment went to a different address.' };
    if (tx.value < price) return { ok: false, problem: `the payment was below ${PRICE_ETH} ETH.` };
    return { ok: true };
  } catch {
    // Broadcast but no receipt yet: non-terminal. Answer settlement_pending so the
    // client keeps the hash instead of paying again.
    return { ok: false, pending: true, problem: 'settlement_pending' };
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

  const header = req.headers['x-payment'];
  if (typeof header === 'string') {
    const decoded = decodePayment(header);
    const txHash = decoded?.payload.txHash ?? null;
    if (!txHash) return send(402, { ...paymentRequired(url.pathname), error: 'x-payment was not a valid payment payload.' });

    const check = await verifyPayment(txHash);
    if (!check.ok) {
      if (check.pending) {
        console.log(`402 settlement_pending for ${txHash.slice(0, 12)}…`);
        res.setHeader('x-settlement-status', 'settlement_pending');
        return send(402, { x402Version: 2, status: 'settlement_pending', error: 'settlement_pending', txHash });
      }
      console.log(`402 again: ${check.problem} (proof ${txHash.slice(0, 12)}…)`);
      return send(402, { ...paymentRequired(url.pathname), error: check.problem });
    }
    const block = await client.getBlockNumber();
    const blockData = await client.getBlock({ blockNumber: block });
    console.log(`200 paid via ${txHash.slice(0, 12)}… (block ${block})`);
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
