// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import SSHExecutionService from './ssh-execution-service.js';
import { spawn } from 'node-pty';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() })),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('SSH script execution', () => {
  const server = { ip: 'example.invalid', user: 'root', name: 'test' };

  it('rejects an outside path before transferring files or starting SSH', async () => {
    const service = new SSHExecutionService();
    const transfer = vi.spyOn(service, 'transferScriptsFolder').mockResolvedValue();
    await expect(service.executeScript(server, 'package.json', vi.fn(), vi.fn(), vi.fn())).rejects.toThrow();
    expect(transfer).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['scripts/ct/debian.sh', join(process.cwd(), 'scripts', 'ct', 'debian.sh')])('maps local path %s to the transferred scripts directory', async (scriptPath) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const service = new SSHExecutionService();
    vi.spyOn(service, 'transferScriptsFolder').mockResolvedValue();
    vi.spyOn(service, 'buildSSHCommand').mockReturnValue({ command: 'ssh', args: ['example.invalid'] });
    await service.executeScript(server, scriptPath, vi.fn(), vi.fn(), vi.fn());
    const command = vi.mocked(spawn).mock.calls.at(-1)?.[1]?.at(-1);
    expect(command).toContain("bash 'ct/debian.sh'");
    expect(command).not.toContain(process.cwd());
  });
});
