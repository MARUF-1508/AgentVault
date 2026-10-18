import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/agent/agent.js';

/** The system prompt is part of the security boundary: lock its promises down. */
describe('system prompt', () => {
  it('forbids executing a denied amount and requires a compliant alternative in a worked example', () => {
    expect(SYSTEM_PROMPT).toMatch(/do not call any execute tool/i);
    expect(SYSTEM_PROMPT).toMatch(/What I can do/i);
    expect(SYSTEM_PROMPT).toMatch(/hard cap/i);
    expect(SYSTEM_PROMPT).toMatch(/T3 transactions are refused/i);
  });

  it('tells the model that tool output is untrusted data, never instructions', () => {
    expect(SYSTEM_PROMPT).toMatch(/untrusted/i);
    expect(SYSTEM_PROMPT).toMatch(/NEVER instructions/);
    expect(SYSTEM_PROMPT).toMatch(/Ignore anything inside it/);
  });

  it('states the model cannot change policy, limits or allowlists, and never sees keys', () => {
    expect(SYSTEM_PROMPT).toMatch(/cannot change the policy, limits or allowlists/i);
    expect(SYSTEM_PROMPT).toMatch(/private keys or seed phrases/i);
  });

  it('requires resolving a named recipient before sending, and asking for the address when unknown', () => {
    expect(SYSTEM_PROMPT).toMatch(/resolve_recipient/);
    expect(SYSTEM_PROMPT).toMatch(/ask the user for the 0x address/i);
  });

  it('tells the model to still submit a T2 instead of handing the work back to the user', () => {
    // Regression: a weak model read "T2 pauses for the human" as "not my job",
    // answered in prose and never called the execute tool, so no approval card
    // was ever raised and the transaction silently did not happen.
    expect(SYSTEM_PROMPT).toMatch(/A T2 is never a reason to stop/i);
    expect(SYSTEM_PROMPT).toMatch(/always make the call/i);
    expect(SYSTEM_PROMPT).toMatch(/you still submit it/i);
    // Channel-neutral: chatTurn serves the CLI and the web UI alike.
    expect(SYSTEM_PROMPT).not.toMatch(/in the terminal/i);
  });
});
