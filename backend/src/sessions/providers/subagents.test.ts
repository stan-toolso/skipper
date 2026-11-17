import { describe, expect, it, vi } from 'vitest';
import { SubagentRecorder, SubagentTracker, type SessionSubagent } from './subagents.js';

const at = new Date('2026-11-17T10:00:00Z');
const tracker = () => new SubagentTracker(() => at);
const started = (task_id: string, extra: Record<string, unknown> = {}) => ({ subtype: 'task_started', task_id, tool_use_id: `tu-${task_id}`, description: `Tâche ${task_id}`, task_type: 'local_agent', subagent_type: 'Explore', ...extra });

describe('SubagentTracker', () => {
  it('suit un sous-agent du début à la fin', () => {
    const t = tracker();
    expect(t.apply(started('a', { is_backgrounded: true }))).toBe('now');
    expect(t.list).toEqual([{ id: 'a', toolUseId: 'tu-a', description: 'Tâche a', agentType: 'Explore', background: true, startedAt: at.toISOString(), toolUses: 0, lastTool: null, summary: null }]);
    expect(t.apply({ subtype: 'task_progress', task_id: 'a', usage: { tool_uses: 3 }, last_tool_name: 'Read' })).toBe('later');
    expect(t.apply({ subtype: 'task_progress', task_id: 'a', usage: { tool_uses: 3 }, last_tool_name: 'Read' })).toBeNull();
    expect(t.list[0]).toMatchObject({ toolUses: 3, lastTool: 'Read' });
    expect(t.apply({ subtype: 'task_notification', task_id: 'a' })).toBe('now');
    expect(t.list).toEqual([]);
  });

  it('ignore les commandes Bash de fond et les tâches ambiantes', () => {
    const t = tracker();
    expect(t.apply(started('b', { task_type: 'local_bash', subagent_type: undefined }))).toBeNull();
    expect(t.apply(started('c', { ambient: true }))).toBeNull();
    expect(t.apply(started('d', { skip_transcript: true }))).toBeNull();
    expect(t.list).toEqual([]);
  });

  it('retire un sous-agent fini par task_updated', () => {
    const t = tracker();
    t.apply(started('a'));
    expect(t.apply({ subtype: 'task_updated', task_id: 'a', patch: { status: 'running' } })).toBeNull();
    expect(t.apply({ subtype: 'task_updated', task_id: 'a', patch: { is_backgrounded: true } })).toBe('now');
    expect(t.list[0].background).toBe(true);
    expect(t.apply({ subtype: 'task_updated', task_id: 'a', patch: { status: 'killed' } })).toBe('now');
    expect(t.list).toEqual([]);
  });

  it('la fin du tour clôt les sous-agents du premier plan, pas ceux de fond', () => {
    const t = tracker();
    t.apply(started('fg'));
    t.apply(started('bg', { is_backgrounded: true }));
    t.apply(started('wf', { task_type: 'local_workflow', subagent_type: undefined, workflow_name: 'spec' }));
    t.apply({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg', task_type: 'local_agent', description: '' }, { task_id: 'wf', task_type: 'local_workflow', description: '' }] });
    expect(t.turnEnded()).toBe(true);
    expect(t.list.map((s) => s.id)).toEqual(['bg', 'wf']);
    expect(t.list[1]).toMatchObject({ agentType: 'spec', background: true });
  });

  it('background_tasks_changed retire un sous-agent de fond dont la notification s\'est perdue', () => {
    const t = tracker();
    t.apply(started('a', { is_backgrounded: true }));
    t.apply(started('b', { is_backgrounded: true }));
    expect(t.apply({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'b', task_type: 'local_agent', description: '' }] })).toBe('now');
    expect(t.list.map((s) => s.id)).toEqual(['b']);
  });
});

describe('SubagentRecorder', () => {
  it('enregistre tout de suite un début, regroupe les avancements, vide à la fin', async () => {
    vi.useFakeTimers();
    try {
      const t = tracker();
      const save = vi.fn(async (_list: SessionSubagent[]) => undefined);
      const r = new SubagentRecorder(t, save, { flushMs: 1000 });
      await r.flush();
      expect(save).toHaveBeenLastCalledWith([]);
      r.changed(t.apply(started('a')));
      await Promise.resolve();
      expect(save).toHaveBeenCalledTimes(2);
      r.changed(t.apply({ subtype: 'task_progress', task_id: 'a', usage: { tool_uses: 1 } }));
      r.changed(t.apply({ subtype: 'task_progress', task_id: 'a', usage: { tool_uses: 2 } }));
      expect(save).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(save).toHaveBeenCalledTimes(3);
      expect(save.mock.calls[2][0]).toMatchObject([{ toolUses: 2 }]);
      await r.dispose();
      expect(save).toHaveBeenLastCalledWith([]);
      await r.flush();
      expect(save).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
