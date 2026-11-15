import { quoteShellArgument } from '../services/backupPath';

/** Preserve arbitrary config contents without expanding shell syntax or heredocs. */
export function buildConfigWriteCommand(path: string, config: string): string {
  if (!/^\/etc\/pve\/nodes\/[A-Za-z0-9_.-]+\/lxc\/[1-9]\d{2,8}\.conf$/.test(path)) throw new Error('Invalid LXC configuration path');
  if (config.includes('\0')) throw new Error('Configuration cannot contain NUL bytes');
  const vmid = /\/(\d+)\.conf$/.exec(path)![1]!;
  return `test ! -d /run/lock/pve-local-restore-${vmid} && printf '%s' ${quoteShellArgument(config)} > ${quoteShellArgument(path)}`;
}
