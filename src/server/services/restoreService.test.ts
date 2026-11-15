// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RestoreService, validateRestoreConfig } from './restoreService';
import { runRemoteCommand, RemoteCommandError } from './remoteCommand';
import { writeFile } from 'node:fs/promises';
import type * as remoteCommandModule from './remoteCommand';

const fixtures = vi.hoisted(() => ({
  db: { getBackupById: vi.fn(), getServerById: vi.fn(), getPBSCredential: vi.fn() },
  storages: vi.fn(),
}));
vi.mock('../database-prisma', () => ({ getDatabase: () => fixtures.db }));
vi.mock('./storageService', () => ({ getStorageService: () => ({ getStorages: fixtures.storages }) }));
vi.mock('node:fs/promises', () => ({ writeFile: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./remoteCommand', async importOriginal => ({
  ...await importOriginal<typeof remoteCommandModule>(), runRemoteCommand: vi.fn(),
}));

const originalConfig = 'rootfs: local-lvm:vm-100-disk-0,size=8G\nunprivileged: 1\n';
const remote = vi.mocked(runRemoteCommand);
const calls = () => remote.mock.calls.map(([, command, label]) => ({ command, label }));
const backup = { id: 1, server_id: 2, container_id: '100', storage_name: 'local', storage_type: 'storage', backup_path: '/var/lib/vz/dump/vzdump-lxc-100-2026_01_01.tar.zst' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(writeFile).mockResolvedValue(undefined);
  fixtures.db.getBackupById.mockResolvedValue({ ...backup });
  fixtures.db.getServerById.mockResolvedValue({ id: 2, ip: 'example.invalid', user: 'root' });
  fixtures.db.getPBSCredential.mockResolvedValue({ pbs_username: 'backup@pbs!restore', pbs_password: 'secret', pbs_ip: 'pbs.invalid', pbs_datastore: 'store' });
  fixtures.storages.mockResolvedValue([{ name: 'pbs', type: 'pbs', server: 'pbs.invalid', datastore: 'store', username: 'backup@pbs!restore', namespace: 'team/dev' }]);
  remote.mockImplementation(async (_server, command, label) => {
    if (label.includes('configuration') || label.startsWith('Verify restored') || label.startsWith('Verify recovered') || label === 'Read backup configuration') return originalConfig;
    if (label === 'Read container status') return 'status: running';
    if (label === 'Verify stopped state') return 'status: stopped';
    if (label === 'Allocate staging ID') return '101';
    if (label === 'Locate recovery archive') {
      const directory = /find '([^']+)'/.exec(command)?.[1];
      const id = command.includes('vzdump-lxc-101-') ? '101' : '100';
      return `${directory}/vzdump-lxc-${id}-2026_01_01.tar.zst\n`;
    }
    return '';
  });
});

function fail(label: string, error = new Error('simulated failure')) {
  const implementation = remote.getMockImplementation()!;
  remote.mockImplementation(async (...args) => {
    if (args[2] === label) throw error;
    return implementation(...args);
  });
}

describe('restore preparation and recovery', () => {
  it.each(['100;id', '99', '1000000000'])('rejects invalid VMID %s before SSH', async id => {
    expect((await new RestoreService().executeRestore(1, id, 2)).success).toBe(false);
    expect(remote).not.toHaveBeenCalled();
  });

  it('rejects a backup from another server or guest', async () => {
    fixtures.db.getBackupById.mockResolvedValue({ ...backup, server_id: 3 });
    expect((await new RestoreService().executeRestore(1, '100', 2)).success).toBe(false);
    expect(remote).not.toHaveBeenCalled();
  });

  it.each(['Prepare local backup copy', 'Verify complete backup archive', 'Read backup configuration'])('keeps the original running when %s fails', async label => {
    fail(label);
    expect((await new RestoreService().executeRestore(1, '100', 2)).success).toBe(false);
    expect(calls().some(call => /pct (stop|destroy|restore) 100/.test(call.command))).toBe(false);
  });

  it.each(['Stop original container', 'Create original recovery backup', 'Persist recovery archive'])('never deletes the original if %s fails', async label => {
    fail(label);
    expect((await new RestoreService().executeRestore(1, '100', 2)).success).toBe(false);
    expect(calls().some(call => call.command === 'pct destroy 100')).toBe(false);
    expect(calls().some(call => call.command === 'pct start 100')).toBe(true);
  });

  it('uses native replacement to preserve ACLs instead of explicit guest deletion', async () => {
    const result = await new RestoreService().executeRestore(1, '100', 2);
    expect(result.success).toBe(true);
    expect(calls().some(call => call.command === 'pct destroy 100')).toBe(false);
    expect(calls().find(call => call.label === 'Restore prepared backup')?.command).toContain('--force 1');
  });

  it('verifies and persists recovery before destroying; keeps the replacement stopped', async () => {
    const result = await new RestoreService().executeRestore(1, '100', 2);
    expect(result.success).toBe(true);
    expect(calls().findIndex(call => call.label === 'Persist recovery archive')).toBeLessThan(calls().findIndex(call => call.label === 'Restore prepared backup'));
    expect(calls().find(call => call.label === 'Restore prepared backup')?.command).toContain('--start 0');
    expect(calls().some(call => call.command.includes('rm -'))).toBe(false);
  });

  it('recovers and restarts the original if replacement fails', async () => {
    fail('Restore prepared backup');
    const result = await new RestoreService().executeRestore(1, '100', 2);
    expect(result.success).toBe(false);
    expect(result.error).toContain('original container recovered');
    expect(calls().find(call => call.label === 'Recover original container')?.command).toContain(result.recoveryPath);
    expect(calls().at(-2)?.command).toBe('pct start 100');
  });

  it('returns the retained archive when rollback fails', async () => {
    fail('Restore prepared backup');
    fail('Recover original container');
    const result = await new RestoreService().executeRestore(1, '100', 2);
    expect(result.error).toContain('manual recovery is required');
    expect(result.recoveryPath).toBeDefined();
    expect(calls().some(call => call.command.includes('rm -'))).toBe(false);
  });

  it('retains the host lock on uncertain completion and does not race a rollback', async () => {
    fail('Restore prepared backup', new RemoteCommandError('connection lost', true));
    const result = await new RestoreService().executeRestore(1, '100', 2);
    expect(result.error).toContain('remote completion is unknown');
    expect(calls().some(call => call.label === 'Recover original container' || call.label === 'Release restore lock')).toBe(false);
  });

  it('prepares PBS through native stopped staging before touching the original', async () => {
    const implementation = remote.getMockImplementation()!;
    remote.mockImplementation(async (...args) => args[2] === 'Read PBS snapshot configuration' ? originalConfig + 'onboot: 1\n' : implementation(...args));
    fixtures.db.getBackupById.mockResolvedValue({ ...backup, storage_type: 'pbs', storage_name: 'pbs', backup_path: 'pbs://legacy@pam@pbs.invalid:store/ct/100/2026-01-01T00:00:00Z' });
    const result = await new RestoreService().executeRestore(1, '100', 2);
    expect(result.success).toBe(true);
    const staged = calls().find(call => call.label === 'Prepare PBS staging container 101');
    expect(staged?.command).toContain("'pbs:backup/ct/100/2026-01-01T00:00:00Z'");
    expect(staged?.command).toContain('--start 0 --onboot 0');
    expect(staged?.command).not.toContain('--force');
    expect(calls().find(call => call.label === 'Restore prepared backup')?.command).toContain('--onboot 1');
    expect(calls().findIndex(call => call.label === 'Remove staging container 101')).toBeLessThan(calls().findIndex(call => call.label === 'Stop original container'));
  });

  it('does not stop or destroy the original if PBS staging fails', async () => {
    fixtures.db.getBackupById.mockResolvedValue({ ...backup, storage_type: 'pbs', storage_name: 'pbs', backup_path: 'ct/100/2026-01-01T00:00:00Z' });
    fail('Prepare PBS staging container 101');
    expect((await new RestoreService().executeRestore(1, '100', 2)).success).toBe(false);
    expect(calls().some(call => /pct (stop|destroy) 100/.test(call.command))).toBe(false);
    expect(calls().some(call => call.command === 'pct destroy 101')).toBe(false);
  });

  it('serializes concurrent restores across service instances', async () => {
    let release!: () => void;
    fixtures.db.getBackupById.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(backup); }));
    const first = new RestoreService().executeRestore(1, '100', 2);
    await vi.waitFor(() => expect(release).toBeDefined());
    const second = await new RestoreService().executeRestore(1, '100', 2);
    expect(second.error).toContain('already in progress');
    release();
    await first;
  });
});

describe('recoverable configuration layouts', () => {
  it.each(['mp0: local:disk,mp=/data', 'mp0: /host,mp=/data', 'unused0: local:disk', 'lock: backup', '[snapshot]', 'lxc.idmap: u 0 100000 65536'])('refuses unsupported layout %s', line => {
    expect(() => validateRestoreConfig(originalConfig + line)).toThrow();
  });
});
