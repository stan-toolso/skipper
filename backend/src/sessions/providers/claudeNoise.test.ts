import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { isNoise } from './claudeNoise.js';

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

describe('isNoise', () => {
  it('écarte les compteurs et états intermédiaires du SDK', () => {
    for (const subtype of ['thinking_tokens', 'task_progress', 'task_updated', 'background_tasks_changed', 'vcs_state_changed']) {
      expect(isNoise(msg({ type: 'system', subtype }))).toBe(true);
    }
    expect(isNoise(msg({ type: 'tool_progress', tool_use_id: 't', elapsed_time_seconds: 3 }))).toBe(true);
  });

  it('garde les messages utiles au transcript', () => {
    for (const subtype of ['init', 'status', 'compact_boundary', 'api_retry', 'task_started', 'task_notification', 'nouveau_sous_type']) {
      expect(isNoise(msg({ type: 'system', subtype }))).toBe(false);
    }
    expect(isNoise(msg({ type: 'assistant', message: { content: [] } }))).toBe(false);
    expect(isNoise(msg({ type: 'result', subtype: 'success' }))).toBe(false);
    // Un sous-type bruyant n'a de sens que sur un message `system`.
    expect(isNoise(msg({ type: 'user', subtype: 'thinking_tokens' }))).toBe(false);
  });
});
