import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type OpenAI from 'openai';
import { erc20Abi, parseUnits } from 'viem';
import { chatTurn } from './agent/agent.js';
import { runTool, type ToolContext } from './agent/tools.js';
import { CliApprover, WebApprover } from './approval/approver.js';
import { TelegramApprover } from './approval/telegram.js';
import { ROLES, type Role } from './auth/rbac.js';
import { UserStore } from './auth/users.js';
import { verifyAnchors } from './audit/anchor.js';
import { AuditLog } from './audit/log.js';
import { makeClients } from './chain/client.js';
import { loadEnv, loadPolicy } from './config.js';
import { parseBatch } from './executor/batch.js';
import { Executor } from './executor/executor.js';
import { explainTier } from './policy/alternative.js';
import { tokenInfo } from './policy/engine.js';
import { addDenied, addRecipient, removeDenied, removeRecipient, writePolicyAtomic } from './policy/edit.js';
import { policyFileHash } from './policy/integrity.js';
import { pauseWallet, resumeWallet } from './policy/killswitch.js';
import { IntentSchema, type Intent } from './policy/types.js';
import { loadSchedules, type Schedules } from './schedule/rules.js';
import { createServer } from './web/server.js';
import { Scheduler } from './schedule/background.js';
import { runDueRules } from './schedule/runner.js';

const USAGE = `Agent Wallet

  npm run cli -- info                              wallet address, chain, balance
  npm run cli -- portfolio                         balances with USD value
  npm run cli -- balance <TOKEN>                   token balance (e.g. USDC)
  npm run cli -- send <to> <amount> [TOKEN] [--task <id> --task-max <amount>] [--dry-run]
                                                   --task caps the total a goal may spend (envelope)
  npm run cli -- approve <TOKEN> <spender> <amount|unlimited> [--dry-run]
  npm run cli -- revoke <TOKEN> <spender> [--dry-run]   set a stale allowance back to 0 (always allowed)
  npm run cli -- swap <tokenIn> <tokenOut> <amountIn> [slippageBps] [--dry-run]
  npm run cli -- preview <to> <amount> [TOKEN]     policy tier only, nothing sent
  npm run cli -- whatif <to> <amount> [TOKEN] [--allow] [--auto N] [--hard N] [--daily N] [--paused]
                                                   read-only: "what would happen if ...?"
  npm run cli -- schedule [list|run]               scheduled / conditional rules
  npm run cli -- x402 [url]                        fetch a paid (x402-style) API resource; the wallet pays if it gets a 402
  npm run cli -- batch <file.json> [--dry-run]     several transfers, all policy-checked together first
  npm run cli -- tx <hash> | pending               status of a sent transaction / all unconfirmed ones
  npm run cli -- pause | resume                    kill switch
  npm run cli -- audit [verify|tail]               audit log
  npm run cli -- audit anchor                      commit the audit head hash on-chain (zero-value self tx)
  npm run cli -- audit verify --onchain [tx…]      check the log against its on-chain anchors
  npm run cli -- policy hash                       sha256 of the policy file (pin it as POLICY_SHA256)
  npm run cli -- serve [--port N]                  web UI (loopback only, sign-in required)
  npm run cli -- user add <name> <owner|operator|viewer>   create a web-UI account (prints its password)
  npm run cli -- user list | remove <name>         manage web-UI accounts
  npm run cli -- recipient list                   allowlist + denylist
  npm run cli -- recipient add <label> <address>  add a known recipient (audited)
  npm run cli -- recipient remove <label>
  npm run cli -- deny add <address> | deny remove <address>
  npm run agent                                    chat with the AI agent
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') return void console.log(USAGE);

  const env = loadEnv();
  if (cmd === 'policy' && (rest[0] === 'hash' || !rest[0])) {
    // Prints the value to pin as POLICY_SHA256 (S4). Deliberately before
    // loadPolicy, so it also works when the current pin no longer matches.
    return void console.log(policyFileHash(env.POLICY_FILE));
  }
  const policy = loadPolicy(env.POLICY_FILE, env.POLICY_SHA256);
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
  if (cmd === 'recipient' || cmd === 'deny') return recipientCommand(env, policy, audit, [cmd, ...rest]);
  if (cmd === 'audit' && rest[0] !== 'anchor' && !rest.includes('--onchain')) {
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
    const webCtx: ToolContext = {
      clients,
      policy,
      executor: webExecutor,
      audit,
      schedules: readSchedules(env.SCHEDULES_FILE),
      x402ApiUrl: env.X402_API_URL,
    };
    const users = new UserStore(env.USERS_FILE);
    if (users.list().length === 0) {
      // The UI shows a first-run setup screen; the CLI path also works.
      console.log('No web accounts yet. Create the first owner in the UI, or run `npm run cli -- user add <name> owner`.');
    }
    // Compliance: record which exact policy this server enforces (S4).
    audit.append('access', { event: 'policy_loaded', by: 'serve', policyHash: policyFileHash(env.POLICY_FILE), pinned: Boolean(env.POLICY_SHA256) });

    // Optional out-of-band approvals (I4).
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const telegram = new TelegramApprover(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, approver, audit);
      approver.addNotifier(telegram);
      telegram.start();
      console.log('Telegram approvals on: T2 requests are also posted to the configured chat.');
    }

    // Background schedules (T5): opt-in, every rule still goes through the executor.
    const scheduler = new Scheduler(
      () => ({ clients, policy, executor: webExecutor, audit, schedules: readSchedules(env.SCHEDULES_FILE) }),
      env.SCHEDULER_INTERVAL_SEC,
    );
    if (env.SCHEDULER === 'true') {
      scheduler.start();
      console.log(`Scheduler on: enabled rules are checked every ${env.SCHEDULER_INTERVAL_SEC} s.`);
    }

    const server = createServer({ env, ctx: webCtx, approver, vault, users, scheduler: scheduler.status });
    await new Promise<void>((resolve) => server.listen(port, env.WEB_HOST, resolve));
    const where = env.WEB_HOST === '127.0.0.1' ? 'loopback only, sign-in required; do not expose' : `bound to ${env.WEB_HOST}`;
    return void console.log(`Agent Vault UI on http://127.0.0.1:${port} (${where}).`);
  }
  const executor = new Executor(clients, policy, audit, new CliApprover(), env.PAUSE_FILE, vault);
  const schedules = readSchedules(env.SCHEDULES_FILE);
  const ctx: ToolContext = { clients, policy, executor, audit, schedules, x402ApiUrl: env.X402_API_URL };
  const dryRun = rest.includes('--dry-run');
  const taskIdx = rest.indexOf('--task');
  const taskMaxIdx = rest.indexOf('--task-max');
  const task = taskIdx >= 0 ? rest[taskIdx + 1] : undefined;
  const taskMax = taskMaxIdx >= 0 ? rest[taskMaxIdx + 1] : undefined;
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--dry-run') continue;
    if (a === '--task' || a === '--task-max') {
      i++;
      continue;
    }
    args.push(a);
  }

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
      if (cmd === 'preview') {
        const { decision, alternative } = await executor.previewWithAlternative(intent);
        return print({ ...decision, explanation: explainTier(decision.tier), ...(alternative ? { alternative } : {}) });
      }
      return print(await executor.execute(intent, { dryRun, task, taskMax }));
    }
    case 'approve': {
      const [token, spender, amount] = args;
      return print(await executor.execute(parseIntent({ kind: 'erc20_approve', token, spender, amount }), { dryRun }));
    }
    case 'revoke': {
      // approve(spender, 0): clean up a stale allowance. The engine always allows
      // this (it can only shrink what the spender may take).
      const [token, spender] = args;
      return print(await executor.execute(parseIntent({ kind: 'erc20_approve', token, spender, amount: '0' }), { dryRun }));
    }
    case 'whatif':
      return cmdWhatIf(args, ctx);
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
    case 'x402':
      return print(await runTool('fetch_paid_data', JSON.stringify({ url: args[0] ?? env.X402_API_URL }), ctx));
    case 'tx': {
      if (!/^0x[0-9a-fA-F]{64}$/.test(args[0] ?? '')) {
        console.error('Usage: tx <0x… transaction hash>');
        process.exitCode = 1;
        return;
      }
      return print(await executor.txStatus(args[0] as `0x${string}`));
    }
    case 'pending':
      return print(executor.pendingTxs());
    case 'batch':
      return cmdBatch(args[0], dryRun, executor, policy);
    case 'audit':
      return cmdAuditOnchain(args, dryRun, ctx);
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

/**
 * Recipient-list edits from the terminal. Same pure helpers and the same atomic
 * write as the web routes, so both paths behave identically; a local shell is
 * already the owner, so there is no password prompt, but every change is still
 * written to the audit log.
 */
function recipientCommand(env: ReturnType<typeof loadEnv>, policy: ReturnType<typeof loadPolicy>, audit: AuditLog, args: string[]): void {
  const [group, sub, a, b] = args;
  const wantsList = group === 'list' || !group || (group !== 'deny' && sub === 'list');
  if (wantsList) {
    const { allowlist, denylist } = policy.recipients;
    const labels = Object.keys(allowlist);
    const width = Math.max(4, ...labels.map((l) => l.length)) + 2;
    console.log('Allowlist (known recipients; can receive automatic T1 transfers):');
    for (const [label, address] of Object.entries(allowlist)) console.log(`  ${label.padEnd(width)}${address}`);
    if (!labels.length) console.log('  (empty)');
    console.log('Denylist (refused outright, T3):');
    for (const address of denylist) console.log(`  ${' '.repeat(width)}${address}`);
    if (!denylist.length) console.log('  (empty)');
    return;
  }
  const save = (event: string, detail: Record<string, unknown>, next: ReturnType<typeof addRecipient>) => {
    writePolicyAtomic(env.POLICY_FILE, next);
    audit.append('access', { event, by: 'cli', ...detail });
    console.log(`Saved. ${event.replace(/_/g, ' ')}. Restart the UI server to pick it up.`);
  };
  try {
    if (group === 'recipient' && sub === 'add' && a && b) {
      const next = addRecipient(policy, a, b);
      save('recipient_added', { label: a, address: b, escalated: true }, next);
      return;
    }
    if (group === 'recipient' && sub === 'remove' && a) {
      const next = removeRecipient(policy, a);
      save('recipient_removed', { label: a }, next);
      return;
    }
    if (group === 'deny' && sub === 'add' && a) {
      const next = addDenied(policy, a);
      save('deny_added', { address: a }, next);
      return;
    }
    if (group === 'deny' && sub === 'remove' && a) {
      const next = removeDenied(policy, a);
      save('deny_removed', { address: a, escalated: true }, next);
      return;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  console.error('Usage: recipient list | recipient add <label> <address> | recipient remove <label>');
  console.error('       deny add <address> | deny remove <address>');
  process.exitCode = 1;
}

/** Reads schedules.json if present; a missing file just means no rules. */
function readSchedules(path: string): Schedules {
  return existsSync(path) ? loadSchedules(path) : { version: 1, rules: [] };
}

/**
 * Vault-routing mode (VAULT=true): native transfers go through agentSend on the
 * deployed vault, so on-chain caps apply. With VAULT_TOKENS=true the vault is an
 * AgentVaultV2 and ERC-20 transfers go through agentSendToken too. Fail closed
 * when the address is missing.
 */
function vaultConfig(env: ReturnType<typeof loadEnv>): { address: `0x${string}`; tokens?: boolean } | undefined {
  if (env.VAULT !== 'true') return undefined;
  if (!env.VAULT_ADDRESS) {
    console.error('VAULT=true but VAULT_ADDRESS is not set. Set it in .env or unset VAULT.');
    process.exit(1);
  }
  return { address: env.VAULT_ADDRESS as `0x${string}`, ...(env.VAULT_TOKENS === 'true' ? { tokens: true } : {}) };
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

/**
 * `whatif <to> <amount> [TOKEN] [--allow] [--auto N] [--hard N] [--daily N] [--paused]`.
 * Read-only: prints the verdict as things stand beside the verdict under the
 * hypothesis. `--allow` says "if this recipient were already known", `--auto` /
 * `--hard` / `--daily` override the per-transaction limits for this asset.
 */
async function cmdWhatIf(args: string[], ctx: ToolContext) {
  const withValue = new Set(['--auto', '--hard', '--daily']);
  const bools = new Set(['--allow', '--paused']);
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (withValue.has(a)) flags[a] = args[++i] ?? '';
    else if (bools.has(a)) flags[a] = true;
    else positional.push(a);
  }
  const [to, amount, token] = positional;
  if (!to || !amount) {
    console.error(`Usage: whatif <to> <amount> [TOKEN] [--allow] [--auto N] [--hard N] [--daily N] [--paused]\n\n${USAGE}`);
    process.exit(1);
  }
  const intent = parseIntent(token ? { kind: 'erc20_transfer', to, amount, token } : { kind: 'native_transfer', to, amount });
  const limits: { autoMaxPerTx?: string; hardMaxPerTx?: string; dailyBudget?: string } = {};
  if (typeof flags['--auto'] === 'string') limits.autoMaxPerTx = flags['--auto'];
  if (typeof flags['--hard'] === 'string') limits.hardMaxPerTx = flags['--hard'];
  if (typeof flags['--daily'] === 'string') limits.dailyBudget = flags['--daily'];
  const result = await ctx.executor.whatIf(intent, {
    ...(flags['--allow'] ? { allowRecipients: [to as `0x${string}`] } : {}),
    ...(flags['--paused'] ? { paused: true } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  });
  return print(result);
}

/**
 * `batch <file.json>`: a JSON array of `{ "to": "<0x… or saved name>", "amount": "0.0001", "token"?: "USDC" }`.
 * The whole batch is policy-checked first with each line counting toward the
 * next, and nothing is sent unless every line passes (T3).
 */
async function cmdBatch(file: string | undefined, dryRun: boolean, executor: Executor, policy: ReturnType<typeof loadPolicy>) {
  if (!file || !existsSync(file)) {
    console.error('Usage: batch <file.json> [--dry-run]   (a JSON array of { to, amount, token? })');
    process.exitCode = 1;
    return;
  }
  const lines = parseBatch(JSON.parse(readFileSync(file, 'utf8')), policy);
  if ('error' in lines) {
    console.error(lines.error);
    process.exitCode = 1;
    return;
  }
  const r = await executor.executeBatch(lines.intents, { dryRun });
  return print({
    preview: r.preview.map((l) => ({ line: l.index + 1, tier: l.decision.tier, reasons: l.decision.reasons })),
    results: r.results.map((x) => ({ status: x.status, tier: x.decision.tier, txHash: x.txHash, error: x.error })),
    ...(r.stoppedAt !== undefined ? { stoppedAt: r.stoppedAt + 1 } : {}),
  });
}

/**
 * `audit anchor`: commit the current head hash on-chain (S2) as a zero-value
 * self-transaction, through the executor like every other state change.
 * `audit verify --onchain [txHash …]`: local hash chain plus every anchor.
 */
async function cmdAuditOnchain(args: string[], dryRun: boolean, ctx: ToolContext) {
  const { audit, executor, clients } = ctx;
  if (args[0] === 'anchor') {
    const head = audit.read().at(-1);
    if (!head) return print({ error: 'The audit log is empty; nothing to anchor.' });
    const r = await executor.execute({ kind: 'audit_anchor', seq: head.seq, headHash: head.hash }, { dryRun });
    if (r.status === 'executed' && r.txHash) {
      audit.append('anchor', { seq: head.seq, headHash: head.hash, txHash: r.txHash, explorerUrl: r.explorerUrl });
    }
    return print({ status: r.status, anchoredSeq: head.seq, headHash: head.hash, txHash: r.txHash, explorerUrl: r.explorerUrl, error: r.error, reasons: r.decision.reasons });
  }
  const local = audit.verify();
  const explicit = args.filter((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
  const onchain = await verifyAnchors(
    audit.read(),
    async (hash) => {
      const tx = await clients.publicClient.getTransaction({ hash });
      return tx ? { input: tx.input, from: tx.from, to: tx.to } : null;
    },
    { wallet: clients.account?.address, ...(explicit.length ? { txHashes: explicit } : {}) },
  );
  if (onchain.checks.length === 0) {
    return print({ local, onchain: { ok: false, checks: [], note: 'No anchors yet. Run `npm run cli -- audit anchor` first.' } });
  }
  if (!local.ok || !onchain.ok) process.exitCode = 1;
  return print({ local, onchain });
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
