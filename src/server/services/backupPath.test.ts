// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { quoteShellArgument } from './backupPath';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';

describe.skipIf(!existsSync(shell))('shell argument boundaries', () => {
  it.each(["it's a value", '$(printf injected)', '`printf injected`', 'spaces; echo injected', 'a\nb', '"quoted"', ''])('preserves %j literally', (value) => {
    const result = spawnSync(shell, ['-c', `printf '%s' ${quoteShellArgument(value)}`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });
});
