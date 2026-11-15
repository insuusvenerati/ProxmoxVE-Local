// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBackupService } from './backupService';
import { runRemoteCommand } from './remoteCommand';

const db = vi.hoisted(() => ({ getPBSCredential: vi.fn() }));
vi.mock('../database-prisma', () => ({ getDatabase: () => db }));
vi.mock('./remoteCommand', () => ({ runRemoteCommand: vi.fn() }));
const server = { id: 2, name: 'pve', ip: 'example.invalid', user: 'root', created_at: null, updated_at: null };
const storage = { name: 'pbs', type: 'pbs', content: ['backup'], supportsBackup: true, server: 'pbs.invalid', datastore: 'store', username: 'operator@pbs!token', namespace: 'team/test' };

beforeEach(() => {
  vi.resetAllMocks();
  db.getPBSCredential.mockResolvedValue({ pbs_username: storage.username, pbs_password: 'not-logged' });
  vi.mocked(runRemoteCommand).mockResolvedValue(JSON.stringify([{ 'backup-id': '100', 'backup-type': 'ct', 'backup-time': 1767225600, size: 1024 }]));
});

describe('PBS backup discovery', () => {
  it('uses the same token identity, namespace and credentials for access and listing', async () => {
    const service = getBackupService();
    expect(await service.loginToPBS(server, storage)).toBe(true);
    const backups = await service.discoverPBSBackups(server, storage, '100', 'debian');
    const commands = vi.mocked(runRemoteCommand).mock.calls.map(([, command]) => command);
    expect(commands).toHaveLength(2);
    commands.forEach(command => expect(command).toContain("PBS_REPOSITORY='operator@pbs!token@pbs.invalid:store'"));
    expect(commands[1]).toContain("--ns 'team/test' --output-format json");
    expect(backups[0]?.backup_path).toBe('pbs://operator@pbs!token@pbs.invalid:store/ct/100/2026-01-01T00:00:00Z');
    expect(backups[0]?.size).toBe(1024n);
  });
  it('rejects an injected ID before database or SSH access', async () => {
    await expect(getBackupService().discoverPBSBackups(server, storage, '100;id', 'debian')).rejects.toThrow();
    expect(runRemoteCommand).not.toHaveBeenCalled();
  });
  it('does not accept snapshots returned for another guest', async () => {
    vi.mocked(runRemoteCommand).mockResolvedValue('[{"backup-id":"101","backup-type":"ct","backup-time":1767225600}]');
    await expect(getBackupService().discoverPBSBackups(server, storage, '100', 'debian')).rejects.toThrow(/another container/);
  });
  it('propagates failed discovery instead of treating error text as snapshot data', async () => {
    vi.mocked(runRemoteCommand).mockRejectedValue(new Error('PBS unavailable'));
    await expect(getBackupService().discoverPBSBackups(server, storage, '100', 'debian')).rejects.toThrow('PBS unavailable');
  });
});
