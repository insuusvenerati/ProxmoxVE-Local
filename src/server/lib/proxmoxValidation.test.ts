// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lxcConfigSchema, parseLXCSnapshot, storageIdSchema, vmidSchema, volumeIdSchema } from './proxmoxValidation';

describe('Proxmox command inputs', () => {
  it.each(['100;id', '$(id)', '100\n', '-100', '99', '1000000000', '1e3'])('rejects VMID %j', value => {
    expect(vmidSchema.safeParse(value).success).toBe(false);
  });
  it.each(['local;id', 'local$(id)', '../storage', 'x\ny'])('rejects storage %j', value => {
    expect(storageIdSchema.safeParse(value).success).toBe(false);
  });
  it.each(['pool:disk;id', 'pool:../../disk', 'pool:$(id)', 'pool:disk\n'])('rejects volume %j', value => {
    expect(volumeIdSchema.safeParse(value).success).toBe(false);
  });
  it('keeps valid volume IDs and token-free snapshot identity', () => {
    expect(volumeIdSchema.parse('local:100/vm-100-disk-0.raw')).toBe('local:100/vm-100-disk-0.raw');
    expect(parseLXCSnapshot('pbs://old@pam@pbs:store/ct/100/2026-01-01T00:00:00Z', '100')).toBe('ct/100/2026-01-01T00:00:00Z');
  });
  it.each(['vm/100/2026-01-01T00:00:00Z', 'ct/101/2026-01-01T00:00:00Z', 'ct/100/$(id)', 'ct/100/2026-99-01T00:00:00Z'])('rejects mismatched or invalid snapshot %j', value => {
    expect(() => parseLXCSnapshot(value, '100')).toThrow();
  });
  it('allows advanced config as literal data but rejects newlines in regular fields', () => {
    const config = { arch: 'amd64', hostname: 'debian', ostype: 'debian', rootfs_storage: 'local-lvm:vm-100-disk-0', cores: 2, memory: 1024, advanced_config: 'EOFCONFIG\n$(id)' };
    expect(lxcConfigSchema.parse(config).advanced_config).toBe(config.advanced_config);
    expect(lxcConfigSchema.safeParse({ ...config, hostname: 'debian\nlock: restore' }).success).toBe(false);
  });
});
