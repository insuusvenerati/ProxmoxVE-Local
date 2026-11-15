import { getSSHExecutionService } from '../ssh-execution-service';
import type { Server } from '~/types/server';
import { quoteShellArgument } from './backupPath';
import { randomUUID } from 'node:crypto';

export class RemoteCommandError extends Error {
  constructor(message: string, public readonly uncertain = false) { super(message); }
}

/** Wait for command exit, rather than the SSH service's early process handle. */
export function runRemoteCommand(server: Server, command: string, label: string, seconds = 3600): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const marker = `__PVE_LOCAL_${randomUUID().replace(/-/g, '')}__`;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => finish(new RemoteCommandError(`${label}: SSH completion was not confirmed`, true)), (seconds + 40) * 1000);
    // Never include the command or captured output in errors: PBS commands contain credentials.
    void getSSHExecutionService().executeCommand(
      server,
      // A completed pct task may itself exit 255. Frame its status separately
      // from SSH's transport status so ordinary failures can safely recover.
      `bash -c ${quoteShellArgument(`set +e; timeout --signal=TERM --kill-after=30s ${seconds} bash -c ${quoteShellArgument(command)}; pve_status=$?; printf '\\n${marker}%s\\n' "$pve_status"; exit 0`)}`,
      (data: string) => { output = (output + data).slice(-2_000_000); },
      () => finish(new RemoteCommandError(`${label}: SSH connection failed`, true)),
      (sshCode: number) => {
        const completion = new RegExp(`\\n${marker}(\\d+)\\r?\\n`).exec(output);
        if (sshCode !== 0 || !completion) {
          finish(new RemoteCommandError(`${label}: remote completion was not confirmed`, true));
          return;
        }
        const code = Number(completion[1]);
        output = output.slice(0, completion.index).replace(/\r\n/g, '\n');
        finish(code === 0 ? undefined : new RemoteCommandError(`${label} failed (exit ${code})`, [124, 137, 143].includes(code)));
      },
    ).catch(() => finish(new RemoteCommandError(`${label}: unable to start SSH command`, true)));
  });
}
