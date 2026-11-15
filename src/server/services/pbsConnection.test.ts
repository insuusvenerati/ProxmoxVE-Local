// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertNativePBSStorage, getPBSConnection } from './pbsConnection';

const storage = { server: 'pbs.invalid', datastore: 'backups', username: 'operator@pbs!restore', namespace: 'team/dev' };
const credential = { pbs_username: 'operator@pbs!restore', pbs_password: "it's $(printf secret)", pbs_fingerprint: "aa:bb" };

describe('PBS connection identity', () => {
  it('uses the configured token identity and namespace consistently', () => {
    const connection = getPBSConnection(credential, storage);
    expect(connection.repository).toBe('operator@pbs!restore@pbs.invalid:backups');
    expect(connection.namespaceArgument).toBe(" --ns 'team/dev'");
    expect(() => assertNativePBSStorage(connection, storage)).not.toThrow();
    expect(connection.environment).toContain("PBS_REPOSITORY='operator@pbs!restore@pbs.invalid:backups'");
  });
  it('supports a legacy default identity and IPv6 hosts', () => {
    expect(getPBSConnection({ pbs_password: 'x' }, { server: '::1', datastore: 'backups' }).repository).toBe('root@pam@[::1]:backups');
  });
  it('rejects native restore with an identity different from Proxmox storage', () => {
    expect(() => assertNativePBSStorage(getPBSConnection(credential, storage), { ...storage, username: 'root@pam' })).toThrow(/must match/);
  });
  it.each([
    { pbs_username: 'root@pam;id' }, { pbs_ip: '$(id)' }, { pbs_datastore: 'x;id' },
  ])('rejects invalid repository components %j', override => {
    expect(() => getPBSConnection({ ...credential, ...override }, storage)).toThrow();
  });
  it('rejects namespace traversal', () => {
    expect(() => getPBSConnection(credential, { ...storage, namespace: '../other' })).toThrow();
  });
});
