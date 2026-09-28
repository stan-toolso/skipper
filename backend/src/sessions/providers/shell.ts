import { AppError } from '../../errors.js';
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
      description: 'Exécute le prompt comme une commande shell en arrière-plan.',
      configFields: [
        { key: 'shell', label: 'Shell', type: 'string', required: false, defaultValue: '/bin/sh' },
      ],
    };
  }

  async start(ctx: RunContext): Promise<RunningHandle> {
    const cfg = ctx.session.config as ShellConfig;
    if (!ctx.session.prompt) throw new AppError('Une session shell nécessite une commande dans le prompt');
    await ctx.emit('system', { message: `Exécution dans ${ctx.cwd} : ${ctx.session.prompt}` });
    return spawnProcess({
      command: cfg.shell || '/bin/sh',
      args: ['-c', ctx.session.prompt],
      cwd: ctx.cwd,
      onStdout: (line) => ctx.emit('stdout', { text: line }),
      onStderr: (line) => ctx.emit('stderr', { text: line }),
    });
  }
}
