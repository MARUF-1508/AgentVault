import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type OpenAI from 'openai';
import { erc20Abi, parseUnits } from 'viem';
import { chatTurn } from './agent/agent.js';
import { runTool, type ToolContext } from './agent/tools.js';
import { CliApprover, WebApprover } from './approval/approver.js';
import { ROLES, type Role } from './auth/rbac.js';
import { UserStore } from './auth/users.js';
import { AuditLog } from './audit/log.js';
import { makeClients } from './chain/client.js';
import { loadEnv, loadPolicy } from './config.js';
import { Executor } from './executor/executor.js';
import { tokenInfo } from './policy/engine.js';
import { pauseWallet, resumeWallet } from './policy/killswitch.js';
import { IntentSchema, type Intent } from './policy/types.js';
import { loadSchedules, type Schedules } from './schedule/rules.js';
import { createServer } from './web/server.js';
import { runDueRules } from './schedule/runner.js';

const USAGE = `Agent Wallet

  npm run cli -- info                              wallet address, chain, balance
  npm run cli -- portfolio                         balances with USD value
  npm run cli -- balance <TOKEN>                   token balance (e.g. USDC)
  npm run cli -- send <to> <amount> [TOKEN] [--dry-run]
  npm run cli -- approve <TOKEN> <spender> <amount|unlimited> [--dry-run]
  npm run cli -- swap <tokenIn> <tokenOut> <amountIn> [slippageBps] [--dry-run]
  npm run cli -- preview <to> <amount> [TOKEN]     policy tier only, nothing sent
  npm run cli -- schedule [list|run]               scheduled / conditional rules
  npm run cli -- pause | resume                    kill switch
  npm run cli -- audit [verify|tail]               audit log
  npm run cli -- serve [--port N]                  web UI (loopback only, sign-in required)
  npm run cli -- user add <name> <owner|operator|viewer>   create a web-UI account (prints its password)
  npm run cli -- user list | remove <name>         manage web-UI accounts
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
    pauseWallet(env.PAUSE_FILE, audit, 'cli');
    return void console.log('Wallet paused. All transactions will be denied until `resume`.');
  }
  if (cmd === 'resume') {
    resumeWallet(env.PAUSE_FILE, audit);
    return void console.log('Wallet resumed.');
  }
  if (cmd === 'user' || cmd === 'users') return userCommand(new UserStore(env.USERS_FILE), rest);
  if (cmd === 'audit') {
    if (rest[0] === 'verify') {
      const v = audit.verify();
      return void console.log(v.ok ? '✅ Audit log intact.' : `❌ Audit log tampered at entry ${v.brokenAt}: ${v.reason}`);
    }
    return void console.log(audit.read().slice(-20).map((e) => `${e.seq}\t${e.ts}\t${e.type}\t${JSON.stringify(e.data)}`).join('\n'));
  }

  const clients = makeClients(env);
  const vault = vaultConfig(env);
  if (cmd === 'serve') {
    const portRaw = rest.find((a) => /^\d+$/.test(a));
    const port = portRaw ? Math.min(Math.max(parseInt(portRaw, 10), 1), 65535) : 5174;
    const approver = new WebApprover();
    const webExecutor = new Executor(clients, policy, audit, approver, env.PAUSE_FILE, vault);
    const webCtx: ToolContext = { clients, policy, executor: webExecutor, audit, schedules: readSchedules(env.SCHEDULES_FILE) };
    const users = new UserStore(env.USERS_FILE);
    if (users.list().length === 0) {
      // First run: create one owner so the UI is never open without a sign-in.
      const password = users.add('owner', 'owner');
      console.log(`No web accounts yet. Created "owner" with password: ${password}`);
      console.log('It is shown once. Add more with `npm run cli -- user add <name> <role>`.');
    }
    const server = createServer({ env, ctx: webCtx, approver, vault, users });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return void console.log(`Agent Vault UI on http://127.0.0.1:${port} (loopback only, sign-in required; do not expose).`);
  }
  const executor = new Executor(clients, policy, audit, new CliApprover(), env.PAUSE_FILE, vault);
  const schedules = readSchedules(env.SCHEDULES_FILE);
  const ctx: ToolContext = { clients, policy, executor, audit, schedules };
  const dryRun = rest.includes('--dry-run');
  const args = rest.filter((a) => a !== '--dry-run');

  switch (cmd) {
    case 'info':
      return print(await runTool('get_wallet_info', '{}', ctx));
    case 'portfolio':
      return print(await runTool('get_portfolio', '{}', ctx));
    case 'balance':
      return print(await runTool('get_token_balance', JSON.stringify({ token: args[0] }), ctx));
    case 'preview':
    case 'send': {
      const [to, amount, token] = args;
      const intent = parseIntent(token ? { kind: 'erc20_transfer', to, amount, token } : { kind: 'native_transfer', to, amount });
      if (cmd === 'preview') return print(await executor.preview(intent));
      return print(await executor.execute(intent, { dryRun }));
    }
    case 'approve': {
      const [token, spender, amount] = args;
      return print(await executor.execute(parseIntent({ kind: 'erc20_approve', token, spender, amount }), { dryRun }));
    }
    case 'swap':
      return cmdSwap(args, dryRun, ctx);
    case 'schedule':
    case 'schedules': {
      if (args[0] === 'run') {
        const results = await runDueRules({ clients, policy, executor, audit, schedules }, { dryRun });
        return print({ ran: results.length, results });
      }
      return print(schedules);
    }
    case 'chat':
      return chat(env, ctx);
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

/** user add <name> <role> | user list | user remove <name>. CLI-only by design. */
function userCommand(users: UserStore, args: string[]): void {
  const [sub, name, role] = args;
  if (sub === 'add' && name && ROLES.includes(role as Role)) {
    const password = users.add(name, role as Role);
    return void console.log(`Saved ${name} (${role}). Password, shown once: ${password}`);
  }
  if (sub === 'remove' && name) return void console.log(users.remove(name) ? `Removed ${name}.` : `No user ${name}.`);
  if (sub === 'list' || !sub) return print(users.list());
  console.error(`Usage: user add <name> <${ROLES.join('|')}> | user list | user remove <name>`);
  process.exitCode = 1;
}

/** Reads schedules.json if present; a missing file just means no rules. */
function readSchedules(path: string): Schedules {
  return existsSync(path) ? loadSchedules(path) : { version: 1, rules: [] };
}

/**
 * Vault-routing mode (VAULT=true): native transfers go through agentSend on the
 * deployed vault, so on-chain caps apply. Fail closed when the address is missing.
 */
function vaultConfig(env: ReturnType<typeof loadEnv>): { address: `0x${string}` } | undefined {
  if (env.VAULT !== 'true') return undefined;
  if (!env.VAULT_ADDRESS) {
    console.error('VAULT=true but VAULT_ADDRESS is not set. Set it in .env or unset VAULT.');
    process.exit(1);
  }
  return { address: env.VAULT_ADDRESS as `0x${string}` };
}

/**
 * swap <tokenIn> <tokenOut> <amountIn> [slippageBps] [--dry-run]
 * Sends a bounded approval first only if the current allowance is short, then the
 * swap. Both steps go through the executor, so both are policy-checked and logged.
 */
async function cmdSwap(args: string[], dryRun: boolean, ctx: ToolContext) {
  const { publicClient, account } = ctx.clients;
  const swap = ctx.policy.swap;
  if (!swap) return print({ error: 'Swaps are not enabled in the policy.' });

  const [tokenInSym, tokenOutSym, amountIn, bpsRaw] = args;
  const tokenIn = tokenInfo(ctx.policy, tokenInSym ?? '');
  if (!tokenIn || !tokenOutSym || !amountIn) {
    console.error(`Usage: swap <tokenIn> <tokenOut> <amountIn> [slippageBps]\n\n${USAGE}`);
    process.exit(1);
  }
  const slippageBps = bpsRaw ? Number(bpsRaw) : swap.autoMaxSlippageBps;
  const intent = parseIntent({ kind: 'swap', tokenIn: tokenInSym, tokenOut: tokenOutSym, amountIn, slippageBps });
  const steps: Record<string, unknown>[] = [];

  // Validate the swap before any approval, so a denied swap leaves no allowance behind.
  const decision = await ctx.executor.preview(intent);
  if (decision.tier === 'T3_DENY') {
    return print({ steps, tier: decision.tier, reasons: decision.reasons, error: 'Swap denied by policy; no approval sent.' });
  }

  if (account) {
    const need = parseUnits(amountIn, tokenIn.decimals);
    const allowance = await publicClient.readContract({
      address: tokenIn.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, swap.router],
    });
    if (allowance >= need) {
      steps.push({ step: 'approve', status: 'skipped', reason: 'allowance sufficient' });
    } else if (dryRun) {
      steps.push({ step: 'approve', status: 'needed', reason: 'would approve exactly amountIn (bounded)' });
    } else {
      const a = await ctx.executor.execute({ kind: 'erc20_approve', token: tokenInSym, spender: swap.router, amount: amountIn });
      steps.push({ step: 'approve', status: a.status, tier: a.decision.tier, txHash: a.txHash });
      if (a.status !== 'executed') return print({ steps, error: 'Approval step did not execute; swap not attempted.' });
    }
  }

  const r = await ctx.executor.execute(intent, { dryRun });
  steps.push({ step: 'swap', status: r.status, tier: r.decision.tier, reasons: r.decision.reasons, txHash: r.txHash, explorerUrl: r.explorerUrl, error: r.error });
  return print({ steps });
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
