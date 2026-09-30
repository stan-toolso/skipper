import { AppError } from '../../errors.js';
import { runner } from '../../runners/index.js';
import { agentGitEnv } from '../../git/agentEnv.js';
import type { ProviderDescription, RunContext, RunningHandle, SessionProvider } from './provider.js';
import { spawnProcess } from './process.js';

interface ShellConfig {
  shell?: string;
}

/**
 * Provider générique : exécute le prompt comme une commande shell.
 * Sert de second type de session et de modèle pour brancher d'autres agents.
 */
export class ShellProvider implements SessionProvider {
  readonly type = 'shell';

  describe(): ProviderDescription {
    return {
      type: this.type,
      label: 'Commande shell',
      description: 'Exécute le prompt comme une commande shell en arrière-plan ; les messages envoyés sont écrits sur son entrée standard.',
      interactive: true,
      configFields: [
        { key: 'shell', label: 'Shell', type: 'string', required: false, defaultValue: '/bin/sh', advanced: true },
      ],
    };
  }

  async start(ctx: RunContext): Promise<RunningHandle> {
    const cfg = ctx.session.config as ShellConfig;
    const command = ctx.session.prompt;
    if (!command) throw new AppError('Une session shell nécessite une commande dans le prompt');
    await ctx.emit('system', { message: `Exécution dans ${ctx.cwd} : ${command}` });
    await ctx.setActivity('busy');
    const spec = await runner.shellCommand(ctx.project, ctx.cwd, cfg.shell || '/bin/sh', command);
    return spawnProcess({
      command: spec.command,
      args: spec.args,
      env: { ...(await agentGitEnv()), ...spec.env },
      cwd: ctx.cwd,
      interactive: true,
      // Une session shell relancée par un message reçoit ce message sur stdin.
      stdin: ctx.initialMessage && ctx.initialMessage !== command ? `${ctx.initialMessage}\n` : undefined,
      onStdout: (line) => ctx.emit('stdout', { text: line }),
      onStderr: (line) => ctx.emit('stderr', { text: line }),
    });
  }
}
