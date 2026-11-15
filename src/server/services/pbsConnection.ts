import { isIP } from 'node:net';
import { quoteShellArgument } from './backupPath';
import { storageIdSchema } from '../lib/proxmoxValidation';

interface PBSCredential {
  pbs_username?: string | null;
  pbs_ip?: string | null;
  pbs_datastore?: string | null;
  pbs_password: string;
  pbs_fingerprint?: string | null;
}
interface PBSStorage {
  server?: unknown;
  datastore?: unknown;
  username?: unknown;
  namespace?: unknown;
}

export function getPBSConnection(credential: PBSCredential, storage: PBSStorage) {
  const nonEmpty = (value: unknown, fallback: string): string => typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
  const username = nonEmpty(credential.pbs_username, 'root@pam');
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+(?:![A-Za-z0-9_.-]+)?$/.test(username)) throw new Error('Invalid PBS authentication ID');
  let host = nonEmpty(credential.pbs_ip, String(storage.server ?? '').trim());
  if (isIP(host) === 6) host = `[${host}]`;
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(host)) throw new Error('Invalid PBS server');
  const datastore = storageIdSchema.parse(nonEmpty(credential.pbs_datastore, String(storage.datastore ?? '')));
  const namespace = String(storage.namespace ?? '').trim();
  if (namespace && !namespace.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && part !== '.' && part !== '..')) throw new Error('Invalid PBS namespace');
  const repository = `${username}@${host}:${datastore}`;
  const environment = [
    `PBS_PASSWORD=${quoteShellArgument(credential.pbs_password)}`,
    `PBS_REPOSITORY=${quoteShellArgument(repository)}`,
    ...(credential.pbs_fingerprint?.trim() ? [`PBS_FINGERPRINT=${quoteShellArgument(credential.pbs_fingerprint.trim())}`] : []),
  ].join(' ');
  const namespaceArgument = namespace ? ` --ns ${quoteShellArgument(namespace)}` : '';
  return { username, host, datastore, namespace, repository, environment, namespaceArgument };
}

/** Native pct restore uses the PVE storage credentials and encryption keys. */
export function assertNativePBSStorage(connection: ReturnType<typeof getPBSConnection>, storage: PBSStorage): void {
  let host = String(storage.server ?? '').trim();
  if (isIP(host) === 6) host = `[${host}]`;
  if (connection.username !== storage.username || connection.host !== host || connection.datastore !== storage.datastore) {
    throw new Error('PBS credentials must match the username, server and datastore configured on the Proxmox storage before native restore');
  }
}
