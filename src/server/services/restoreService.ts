import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getDatabase } from '../database-prisma';
import { databaseIdSchema, parseLXCSnapshot, storageIdSchema, vmidSchema } from '../lib/proxmoxValidation';
import { getStorageService } from './storageService';
import { quoteShellArgument as q } from './backupPath';
import { assertNativePBSStorage, getPBSConnection } from './pbsConnection';
import { RemoteCommandError, runRemoteCommand } from './remoteCommand';
import type { Server } from '~/types/server';

export interface RestoreProgress { step: string; message: string }
export interface RestoreResult {
  success: boolean;
  error?: string;
  progress: RestoreProgress[];
  recoveryPath?: string;
}

/** Restrict replacement to layouts one vzdump archive can recover. */
export function validateRestoreConfig(config: string): string {
  if (/^(?:mp\d+|unused\d+|dev\d+|lxc\.mount\.entry|lxc\.idmap|lock):/m.test(config) || /^\[/m.test(config) || /^protection:\s*1\s*$/m.test(config)) {
    throw new Error('Restore requires a single root disk without extra mounts, unused disks, custom ID maps, snapshots or locks; use Proxmox for this guest');
  }
  const rootfs = /^rootfs:\s*([A-Za-z][A-Za-z0-9_.-]*):[^\s,]+/m.exec(config);
  if (!rootfs?.[1]) throw new Error('A storage-backed LXC root disk is required');
  return storageIdSchema.parse(rootfs[1]);
}

// The application shares one progress log, so serialize restores across instances.
let restoreActive = false;

export class RestoreService {
  async executeRestore(backupId: number, containerId: string, serverId: number, onProgress?: (progress: RestoreProgress) => void): Promise<RestoreResult> {
    const progress: RestoreProgress[] = [];
    if (restoreActive) return { success: false, error: 'Another restore is already in progress', progress };
    restoreActive = true;
    const logPath = join(process.cwd(), 'restore.log');
    const log = async (step: string, message: string) => {
      const item = { step, message };
      progress.push(item);
      await writeFile(logPath, `${message}\n`, { flag: 'a' }).catch(() => undefined);
      try { onProgress?.(item); } catch { /* presentation cannot abort recovery */ }
    };
    let server: Server | undefined;
    let recoveryPath: string | undefined;
    let job: string | undefined;
    let sourcePath: string | undefined;
    let stagingContainerId: string | undefined;
    let storage: string | undefined;
    let remoteLocked = false;
    let uncertain = false;
    let stopped = false;
    let wasRunning = false;
    let replacementStarted = false;
    let recovered = false;
    const lock = `/run/lock/pve-local-restore-${containerId}`;
    const record = async (phase: string) => {
      if (!server || !job) return;
      const manifest = JSON.stringify({ backupId, serverId, containerId, storage, wasRunning, recoveryPath, sourcePath, stagingContainerId, phase });
      await runRemoteCommand(server, `printf '%s\n' ${q(manifest)} > ${q(`${job}/recovery.json`)} && sync -f ${q(`${job}/recovery.json`)}`, 'Save recovery manifest', 30);
    };
    const verifyArchive = async (path: string) => {
      await runRemoteCommand(server!, `test -f ${q(path)} && test -s ${q(path)} && tar -tf ${q(path)} > /dev/null`, 'Verify complete backup archive');
      validateRestoreConfig(await runRemoteCommand(server!, `pvesm extractconfig ${q(path)}`, 'Read backup configuration', 60));
    };
    try {
      vmidSchema.parse(containerId);
      databaseIdSchema.parse(serverId);
      databaseIdSchema.parse(backupId);
      await writeFile(logPath, '').catch(() => undefined);
      const db = getDatabase();
      const backup = await db.getBackupById(backupId);
      if (backup?.server_id !== serverId || backup.container_id !== containerId) throw new Error('Backup does not belong to this server and container');
      const savedServer = await db.getServerById(serverId);
      if (!savedServer) throw new Error('Server not found');
      server = savedServer as unknown as Server;
      await runRemoteCommand(server, `mkdir ${q(lock)}`, 'Acquire restore lock', 30);
      remoteLocked = true;
      // Raw config includes snapshot sections which pct config omits.
      const originalConfig = await runRemoteCommand(server, `cat ${q(`/etc/pve/lxc/${containerId}.conf`)}`, 'Read original LXC configuration', 30);
      storage = validateRestoreConfig(originalConfig);
      const ha = await runRemoteCommand(server, 'if test -e /etc/pve/ha/resources.cfg; then cat /etc/pve/ha/resources.cfg; fi', 'Check HA resources', 30);
      if (new RegExp(`^ct:\\s*${containerId}(?:\\s|$)`, 'm').test(ha)) throw new Error('HA-managed containers must be restored through Proxmox');
      const status = (await runRemoteCommand(server, `pct status ${containerId}`, 'Read container status', 30)).trim();
      if (!/^status: (running|stopped)$/.test(status)) throw new Error('Unable to determine original container state');
      wasRunning = status === 'status: running';
      job = `/var/lib/vz/dump/pve-local-restore-${randomUUID()}`;
      await runRemoteCommand(server, `umask 077; mkdir ${q(job)} && mkdir ${q(`${job}/source`)} ${q(`${job}/original`)}`, 'Create recovery directory', 30);
      await log('preparing', `Preparing backup. Recovery files will be retained at ${job}`);
      await record('preparing');
      let source: string;
      let sourceOnboot: number | undefined;
      if (backup.storage_type === 'pbs') {
        const snapshot = parseLXCSnapshot(backup.backup_path, containerId);
        const pbsStorage = (await getStorageService().getStorages(server, false)).find(item => item.name === backup.storage_name && item.type === 'pbs');
        if (!pbsStorage) throw new Error('PBS storage not found on this server');
        storageIdSchema.parse(pbsStorage.name);
        const credential = await db.getPBSCredential(serverId, pbsStorage.name);
        if (!credential) throw new Error('PBS credentials are missing');
        // Native restoration preserves config, firewall, ID mapping and encryption.
        assertNativePBSStorage(getPBSConnection(credential, pbsStorage), pbsStorage);
        const volume = `${pbsStorage.name}:backup/${snapshot}`;
        const sourceConfig = await runRemoteCommand(server, `pvesm extractconfig ${q(volume)}`, 'Read PBS snapshot configuration', 120);
        validateRestoreConfig(sourceConfig);
        sourceOnboot = /^onboot:\s*1\s*$/m.test(sourceConfig) ? 1 : 0;
        const stagedId = vmidSchema.parse((await runRemoteCommand(server, 'pvesh get /cluster/nextid --output-format json', 'Allocate staging ID', 30)).trim());
        if (stagedId === containerId) throw new Error('Staging VMID must differ from the original');
        stagingContainerId = stagedId;
        await record('pbs_staging');
        await log('pbs_prepare', `Preparing PBS snapshot in stopped staging container ${stagedId}; original container is unchanged`);
        // No --force: allocation races must fail without replacing another guest.
        await runRemoteCommand(server, `pct restore ${stagedId} ${q(volume)} --storage ${q(storage)} --start 0 --onboot 0`, `Prepare PBS staging container ${stagedId}`);
        await runRemoteCommand(server, `vzdump ${stagedId} --mode stop --compress zstd --dumpdir ${q(`${job}/source`)} --remove 0`, 'Export prepared PBS backup');
        source = await this.findArchive(server, `${job}/source`, stagedId);
        await verifyArchive(source);
        // Clean only a guest whose creation was confirmed successful.
        await runRemoteCommand(server, `pct destroy ${stagedId}`, `Remove staging container ${stagedId}`, 120);
      } else {
        if (!['local', 'storage'].includes(backup.storage_type)) throw new Error('Unsupported backup type');
        const name = basename(backup.backup_path);
        if (!backup.backup_path.startsWith('/') || !new RegExp(`^vzdump-lxc-${containerId}-.+\\.tar(?:\\.(?:zst|gz|lzo|xz|bz2))?$`).test(name) || /[\r\n\0]/.test(backup.backup_path)) throw new Error('Expected an absolute LXC backup archive path');
        source = `${job}/source/${name}`;
        await runRemoteCommand(server, `cp --reflink=auto -- ${q(backup.backup_path)} ${q(source)}`, 'Prepare local backup copy');
        await verifyArchive(source);
      }
      sourcePath = source;
      await record('source_prepared');
      await log('stopping', 'Backup is prepared. Stopping the original to create a recovery archive...');
      stopped = true;
      if (wasRunning) await runRemoteCommand(server, `pct stop ${containerId}`, 'Stop original container', 120);
      if ((await runRemoteCommand(server, `pct status ${containerId}`, 'Verify stopped state', 30)).trim() !== 'status: stopped') throw new Error('Original container is not stopped');
      if (await runRemoteCommand(server, `cat ${q(`/etc/pve/lxc/${containerId}.conf`)}`, 'Recheck original configuration', 30) !== originalConfig) throw new Error('Container configuration changed during preparation');
      await runRemoteCommand(server, `vzdump ${containerId} --mode stop --compress zstd --dumpdir ${q(`${job}/original`)} --remove 0`, 'Create original recovery backup');
      recoveryPath = await this.findArchive(server, `${job}/original`, containerId);
      await verifyArchive(recoveryPath);
      await runRemoteCommand(server, `sync -f ${q(recoveryPath)}`, 'Persist recovery archive', 60);
      await record('recovery_verified');
      await log('recovery', `Verified original recovery archive retained at ${recoveryPath}`);
      await record('replacing');
      // Native replacement keeps VM ACLs/pool membership. Explicit pct destroy
      // removes them and vzdump cannot recover ACL entries.
      replacementStarted = true;
      await runRemoteCommand(server, `pct restore ${containerId} ${q(source)} --storage ${q(storage)} --force 1 --start 0${sourceOnboot === undefined ? '' : ` --onboot ${sourceOnboot}`}`, 'Restore prepared backup');
      if (validateRestoreConfig(await runRemoteCommand(server, `pct config ${containerId}`, 'Verify restored container', 30)) !== storage) throw new Error('Restored container is not on the expected root disk storage');
      await record('complete').catch(() => log('warning', 'Restore succeeded but completion manifest could not be updated'));
      await log('complete', 'Restore completed successfully. Container is stopped; recovery archive is retained.');
      return { success: true, progress, recoveryPath };
    } catch (error) {
      uncertain = error instanceof RemoteCommandError && error.uncertain;
      let message = error instanceof Error ? error.message : 'Restore failed';
      if (server && replacementStarted && recoveryPath && storage && !uncertain) {
        await log('rollback', 'Replacement failed. Recovering the original from the verified archive...');
        try {
          // Failed replacements were never started. Force handles their partial config.
          await runRemoteCommand(server, `pct restore ${containerId} ${q(recoveryPath)} --storage ${q(storage)} --force 1 --start 0`, 'Recover original container');
          if (validateRestoreConfig(await runRemoteCommand(server, `pct config ${containerId}`, 'Verify recovered original', 30)) !== storage) throw new Error('Recovered container storage could not be verified');
          recovered = true;
          await record('original_recovered').catch(() => undefined);
          message += '; original container recovered';
        } catch (rollbackError) {
          uncertain ||= rollbackError instanceof RemoteCommandError && rollbackError.uncertain;
          message += '; automatic recovery failed, manual recovery is required';
        }
      }
      if (server && stopped && wasRunning && (!replacementStarted || recovered) && !uncertain) {
        try { await runRemoteCommand(server, `pct start ${containerId}`, 'Restart original container', 120); }
        catch { message += '; original could not be restarted automatically'; }
      }
      if (uncertain) message += '; remote completion is unknown: restore lock retained, inspect the host before retrying';
      if (job) message += `; recovery directory: ${job}`;
      await log('error', `Error: ${message}`);
      return { success: false, error: message, progress, recoveryPath };
    } finally {
      if (server && remoteLocked && !uncertain) await runRemoteCommand(server, `rmdir ${q(lock)}`, 'Release restore lock', 30).catch(() => undefined);
      restoreActive = false;
    }
  }

  private async findArchive(server: Server, directory: string, vmid: string): Promise<string> {
    const output = await runRemoteCommand(server, `find ${q(directory)} -maxdepth 1 -type f -name ${q(`vzdump-lxc-${vmid}-*.tar.zst`)} -print`, 'Locate recovery archive', 30);
    const files = output.trim().split(/\r?\n/);
    if (files.length !== 1 || !files[0]?.startsWith(`${directory}/`) || files[0].includes('/../') || !/^vzdump-lxc-\d+-[A-Za-z0-9_.:-]+\.tar\.zst$/.test(basename(files[0]))) throw new Error('Expected exactly one recovery archive in the private job directory');
    return files[0];
  }
}

let restoreServiceInstance: RestoreService | undefined;
export function getRestoreService(): RestoreService { return restoreServiceInstance ??= new RestoreService(); }
