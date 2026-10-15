import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** Human-in-the-loop for T2 transactions. Swap for a web/Telegram approver later. */
export interface Approver {
  confirm(summary: string): Promise<boolean>;
}

export class CliApprover implements Approver {
  async confirm(summary: string): Promise<boolean> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(`\n⚠️  Approval required\n${summary}\nApprove this transaction? Type "yes" to approve: `);
      return answer.trim().toLowerCase() === 'yes';
    } finally {
      rl.close();
    }
  }
}

/** Never approves. Useful for tests and fully autonomous (T1-only) runs. */
export class DenyAllApprover implements Approver {
  async confirm(): Promise<boolean> {
    return false;
  }
}
