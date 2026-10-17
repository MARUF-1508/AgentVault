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
});
