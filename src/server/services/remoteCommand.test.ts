// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRemoteCommand } from './remoteCommand';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const ssh = vi.hoisted(() => ({ executeCommand: vi.fn() }));
vi.mock('../ssh-execution-service', () => ({ getSSHExecutionService: () => ssh }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
const server = { id: 1, name: 'test', ip: 'example.invalid', user: 'root', password: 'unused', created_at: null, updated_at: null };
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

describe('remote command completion', () => {
  it('waits for exit rather than accepting the initial process handle', async () => {
    vi.useFakeTimers();
    let exit!: (code: number) => void;
    ssh.executeCommand.mockImplementation((_server, command: string, data: (value: string) => void, _error, onExit: (code: number) => void) => {
      const marker = /__PVE_LOCAL_[a-f0-9]+__/.exec(command)![0];
      data(`result\n${marker}0\n`); exit = onExit; return Promise.resolve({});
    });
    let complete = false;
    const command = runRemoteCommand(server, 'true', 'test').then(value => { complete = true; return value; });
    await Promise.resolve();
    expect(complete).toBe(false);
    exit(0);
    expect(await command).toBe('result');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not include commands, output or secrets in errors', async () => {
    ssh.executeCommand.mockImplementation((_server, command: string, data: (value: string) => void, _error, exit: (code: number) => void) => {
      const marker = /__PVE_LOCAL_[a-f0-9]+__/.exec(command)![0];
      data(`secret\n${marker}1\n`); exit(0); return Promise.resolve({});
    });
    await expect(runRemoteCommand(server, 'PBS_PASSWORD=secret false', 'PBS check')).rejects.toThrow('PBS check failed (exit 1)');
  });
  it('treats SSH startup rejection as uncertain completion', async () => {
    ssh.executeCommand.mockRejectedValue(new Error('secret details'));
    await expect(runRemoteCommand(server, 'secret', 'test')).rejects.toMatchObject({ uncertain: true, message: 'test: unable to start SSH command' });
  });
  it('treats a remote timeout as uncertain completion', async () => {
    ssh.executeCommand.mockImplementation((_server, command: string, data: (value: string) => void, _error, exit: (code: number) => void) => {
      const marker = /__PVE_LOCAL_[a-f0-9]+__/.exec(command)![0];
      data(`\n${marker}124\n`); exit(0); return Promise.resolve({});
    });
    await expect(runRemoteCommand(server, 'sleep 99', 'test')).rejects.toMatchObject({ uncertain: true });
  });
  it('distinguishes a completed pct task exiting 255 from an SSH failure', async () => {
    ssh.executeCommand.mockImplementation((_server, command: string, data: (value: string) => void, _error, exit: (code: number) => void) => {
      const marker = /__PVE_LOCAL_[a-f0-9]+__/.exec(command)![0];
      data(`\n${marker}255\n`); exit(0); return Promise.resolve({});
    });
    await expect(runRemoteCommand(server, 'pct restore', 'Restore')).rejects.toMatchObject({ uncertain: false, message: 'Restore failed (exit 255)' });
  });
  it('retains uncertainty when SSH closes without a completion marker', async () => {
    ssh.executeCommand.mockImplementation((_server, _command, _data, _error, exit: (code: number) => void) => {
      exit(255); return Promise.resolve({});
    });
    await expect(runRemoteCommand(server, 'pct restore', 'Restore')).rejects.toMatchObject({ uncertain: true });
  });
  it.skipIf(!existsSync(shell))('frames real shell output and handles a completed task exiting 255', async () => {
    ssh.executeCommand.mockImplementation((_server, command: string, data: (value: string) => void, _error, exit: (code: number) => void) => {
      const result = spawnSync(shell, ['-c', command], { encoding: 'utf8' });
      data(result.stdout); exit(result.status ?? 255); return Promise.resolve({});
    });
    expect(await runRemoteCommand(server, "printf 'output'", 'test', 2)).toBe('output');
    await expect(runRemoteCommand(server, 'exit 255', 'test', 2)).rejects.toMatchObject({ uncertain: false });
  });
});
