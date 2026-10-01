import { describe, expect, it, vi } from 'vitest';

// Le service des terminaux charge node-pty (binaire natif absent des tests).
vi.mock('../terminals/service.js', () => ({ terminalService: { liveCount: () => 0 } }));

const { parseClaudeProcesses } = await import('./service.js');

describe('processus Claude', () => {
  it("compte les agents, pas les relais docker exec ni la connexion du compte", () => {
    const ps = [
      '  101  350000   3600 claude --output-format stream-json --verbose',
      '  102  420000    120 node /usr/local/bin/claude --output-format stream-json',
      '  103    4000    120 docker exec -i -w /w skipper-x claude --output-format stream-json',
      '  104    2000    120 /bin/sh /home/skipper/skipper-workspaces/.runners/x/claude --output-format stream-json',
      '  105   90000     10 /home/skipper/.local/bin/claude auth login',
      '  106   50000     10 node dist/index.js',
      '  107  300000     10 node /app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js --input-format stream-json',
    ].join('\n');
    expect(parseClaudeProcesses(ps)).toEqual([
      { pid: 101, rssMb: 342, elapsedSeconds: 3600 },
      { pid: 102, rssMb: 410, elapsedSeconds: 120 },
      { pid: 107, rssMb: 293, elapsedSeconds: 10 },
    ]);
  });
});
