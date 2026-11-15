// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildConfigWriteCommand } from './proxmoxCommands';
import { quoteShellArgument } from '../services/backupPath';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

describe('configuration write boundary', () => {
  it('rejects untrusted destination paths', () => {
    expect(() => buildConfigWriteCommand('/tmp/other', 'text')).toThrow();
  });
  it.skipIf(!existsSync(shell))('writes heredoc terminators and command substitutions literally', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pve-config-test-'));
    try {
      const path = '/etc/pve/nodes/pve/lxc/100.conf';
      const target = join(directory, 'config').replace(/\\/g, '/');
      const sentinel = join(directory, 'executed').replace(/\\/g, '/');
      const text = `hostname: test\nEOFCONFIG\ntouch ${quoteShellArgument(sentinel)}\n$(touch ${quoteShellArgument(sentinel)})\n'"`;
      const command = buildConfigWriteCommand(path, text).replace(quoteShellArgument(path), quoteShellArgument(target));
      const result = spawnSync(shell, ['-c', command], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(readFileSync(target, 'utf8')).toBe(text);
      expect(existsSync(sentinel)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
