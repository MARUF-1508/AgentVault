import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type OpenAI from 'openai';
import { chatTurn } from './agent/agent.js';
import { runTool, type ToolContext } from './agent/tools.js';
import { CliApprover } from './approval/approver.js';
import { AuditLog } from './audit/log.js';
import { makeClients } from './chain/client.js';
import { loadEnv, loadPolicy } from './config.js';
import { Executor } from './executor/executor.js';
import { IntentSchema, type Intent } from './policy/types.js';

const USAGE = `Agent Wallet

  npm run cli -- info                              wallet address, chain, balance
  npm run cli -- balance <TOKEN>                   token balance (e.g. USDC)
  npm run cli -- send <to> <amount> [TOKEN] [--dry-run]
  npm run cli -- approve <TOKEN> <spender> <amount|unlimited> [--dry-run]
  npm run cli -- preview <to> <amount> [TOKEN]     policy tier only, nothing sent
  npm run cli -- pause | resume                    kill switch
  npm run cli -- audit [verify|tail]               audit log
  npm run agent                                    chat with the AI agent
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') return void console.log(USAGE);

  const env = loadEnv();
  const policy = loadPolicy(env.POLICY_FILE);
  const audit = new AuditLog(env.AUDIT_LOG);

  // Commands that need no chain connection
  if (cmd === 'pause') {
    mkdirSync(dirname(env.PAUSE_FILE), { recursive: true });
    writeFileSync(env.PAUSE_FILE, new Date().toISOString());
    audit.append('kill_switch', { paused: true });
    return void console.log('Wallet paused. All transactions will be denied until `resume`.');
  }
  if (cmd === 'resume') {
    rmSync(env.PAUSE_FILE, { force: true });
    audit.append('kill_switch', { paused: false });
    return void console.log('Wallet resumed.');
  }
  if (cmd === 'audit') {
    if (rest[0] === 'verify') {
      const v = audit.verify();
      return void console.log(v.ok ? '✅ Audit log intact.' : `❌ Audit log tampered at entry ${v.brokenAt}: ${v.reason}`);
    }
    return void console.log(audit.read().slice(-20).map((e) => `${e.seq}\t${e.ts}\t${e.type}\t${JSON.stringify(e.data)}`).join('\n'));
  }

  const clients = makeClients(env);
  const executor = new Executor(clients, policy, audit, new CliApprover(), env.PAUSE_FILE);
  const ctx: ToolContext = { clients, policy, executor, audit };
  const dryRun = rest.includes('--dry-run');
  const args = rest.filter((a) => a !== '--dry-run');

  switch (cmd) {
    case 'info':
      return print(await runTool('get_wallet_info', '{}', ctx));
    case 'balance':
      return print(await runTool('get_token_balance', JSON.stringify({ token: args[0] }), ctx));
    case 'preview':
    case 'send': {
      const [to, amount, token] = args;
      const intent = parseIntent(token ? { kind: 'erc20_transfer', to, amount, token } : { kind: 'native_transfer', to, amount });
      if (cmd === 'preview') return print(executor.preview(intent));
      return print(await executor.execute(intent, { dryRun }));
    }
    case 'approve': {
      const [token, spender, amount] = args;
      return print(await executor.execute(parseIntent({ kind: 'erc20_approve', token, spender, amount }), { dryRun }));
    }
    case 'chat':
      return chat(env, ctx);
    default:
      console.log(USAGE);
  }
}

async function chat(env: ReturnType<typeof loadEnv>, ctx: ToolContext) {
  const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  console.log(`Agent Wallet on ${ctx.clients.chain.name}. Type "exit" to quit.`);
  while (true) {
    // A fresh readline per turn so the approval prompt can take over stdin cleanly.
    const rl = createInterface({ input: stdin, output: stdout });
    const line = (await rl.question('\nyou › ')).trim();
    rl.close();
    if (!line) continue;
    if (line === 'exit') break;
    try {
      const answer = await chatTurn(env, ctx, history, line, (e) => console.log(`  ${e}`));
      console.log(`\nagent › ${answer}`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
    }
  }
}

function parseIntent(raw: Record<string, unknown>): Intent {
  const r = IntentSchema.safeParse(raw);
  if (!r.success) {
    console.error(`Invalid arguments: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n\n${USAGE}`);
    process.exit(1);
  }
  return r.data;
}

function print(v: unknown) {
  console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
