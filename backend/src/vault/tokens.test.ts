import { describe, expect, it } from 'vitest';
import { isTokenService, OPENCODE_TOKEN_SERVICES, tokenMismatch, tokenServiceLabel } from './tokens.js';

describe('jetons applicatifs', () => {
  it('reconnaît les services et leurs libellés', () => {
    expect(isTokenService('github')).toBe(true);
    expect(isTokenService('slack')).toBe(false);
    expect(tokenServiceLabel('openai')).toBe('OpenAI');
    expect(tokenServiceLabel('inconnu')).toBe('inconnu');
    expect(OPENCODE_TOKEN_SERVICES).toContain('anthropic');
    expect(OPENCODE_TOKEN_SERVICES).not.toContain('github');
  });
  it('vérifie la forme des jetons saisis à la main', () => {
    expect(tokenMismatch('anthropic', 'sk-ant-api03-xxxx')).toBeNull();
    expect(tokenMismatch('anthropic', 'sk-xxxx')).toMatch(/sk-ant-/);
    expect(tokenMismatch('github', 'ghp_' + 'a'.repeat(30))).toBeNull();
    expect(tokenMismatch('github', 'github_pat_' + 'a'.repeat(30))).toBeNull();
    expect(tokenMismatch('github', 'abc')).toMatch(/GitHub/);
    expect(tokenMismatch('claude', 'sk-ant-' + 'a'.repeat(50))).toBeNull();
    expect(tokenMismatch('claude', 'sk-ant-court')).toMatch(/Claude/);
    expect(tokenMismatch('google', 'nimporte')).toBeNull();
  });
});
