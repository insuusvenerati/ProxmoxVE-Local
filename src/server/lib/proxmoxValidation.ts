import { z } from 'zod';

export const vmidSchema = z.string().regex(/^[1-9]\d{2,8}$/).refine(
  value => Number(value) >= 100 && Number(value) <= 999999999,
  'VMID must be between 100 and 999999999',
);
export const storageIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(128);
export const databaseIdSchema = z.number().int().positive().safe();
export const hostnameSchema = z.string().max(253).regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/);
export const volumeIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*:[A-Za-z0-9_./-]+$/)
  .refine(value => !value.split(/[/:]/).includes('..'), 'Invalid volume path');

const configScalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const lxcConfigSchema = z.object({
  arch: z.string().regex(/^[A-Za-z0-9_-]+$/),
  hostname: hostnameSchema,
  ostype: z.string().regex(/^[A-Za-z0-9_-]+$/),
  rootfs_storage: volumeIdSchema,
  rootfs_size: z.string().regex(/^\d+(?:\.\d+)?[KMGT]?$/i).optional(),
  advanced_config: z.string().max(262144).optional(),
}).catchall(configScalar).superRefine((config, ctx) => {
  for (const [key, value] of Object.entries(config)) {
    if (key !== 'advanced_config' && typeof value === 'string' && /[\r\n\0]/.test(value)) ctx.addIssue({ code: 'custom', path: [key], message: 'Configuration field must be a single line' });
  }
});

export function parseLXCSnapshot(path: string, vmid: string): string {
  vmidSchema.parse(vmid);
  const snapshot = path.replace(/^pbs:\/\/[^/]+\//, '');
  const match = /^ct\/([1-9]\d{2,8})\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(snapshot);
  if (match?.[1] !== vmid || !Number.isFinite(Date.parse(match[2]!))) {
    throw new Error('Backup must be an LXC snapshot for the selected container');
  }
  return snapshot;
}
