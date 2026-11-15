import { getSSHExecutionService } from '../ssh-execution-service';
import { getStorageService } from './storageService';
import { getDatabase } from '../database-prisma';
import type { Server } from '~/types/server';
import type { Storage } from './storageService';
import { getStorageDumpPath, quoteShellArgument } from './backupPath';
import { getPBSConnection } from './pbsConnection';
import { runRemoteCommand } from './remoteCommand';
import { parseLXCSnapshot, vmidSchema } from '../lib/proxmoxValidation';
import { z } from 'zod';

const pbsSnapshotListSchema = z.array(z.object({
  'backup-id': z.string(), 'backup-type': z.literal('ct'),
  'backup-time': z.number().int().nonnegative().max(253402300799),
  size: z.number().int().nonnegative().safe().optional(),
}));

export interface BackupData {
  container_id: string;
  server_id: number;
  hostname: string;
  backup_name: string;
  backup_path: string;
  size?: bigint;
  created_at?: Date;
  storage_name: string;
  storage_type: 'local' | 'storage' | 'pbs';
}

class BackupService {
  /**
   * Get server hostname via SSH
   */
  async getServerHostname(server: Server): Promise<string> {
    const sshService = getSSHExecutionService();
    let hostname = '';
    
    await new Promise<void>((resolve, reject) => {
      void sshService.executeCommand(
        server,
        'hostname',
        (data: string) => {
          hostname += data;
        },
        (_error: string) => {
          reject(new Error(`Failed to get hostname: ${_error}`));
        },
        (_exitCode: number) => {
          if (_exitCode === 0) {
            resolve();
          } else {
            reject(new Error(`hostname command failed with exit code ${_exitCode}`));
          }
        }
      );
    });
    
    return hostname.trim();
  }

  /**
   * Discover local backups in /var/lib/vz/dump/
   */
  async discoverLocalBackups(server: Server, ctId: string, hostname: string): Promise<BackupData[]> {
    vmidSchema.parse(ctId);
    const sshService = getSSHExecutionService();
    const backups: BackupData[] = [];
    
    // Find backup files matching pattern (with timeout)
    const findCommand = `timeout 10 find /var/lib/vz/dump/ -type f -name "vzdump-lxc-${ctId}-*.tar*" 2>/dev/null`;
    let findOutput = '';
    
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          void sshService.executeCommand(
            server,
            findCommand,
            (data: string) => {
              findOutput += data;
            },
            (error: string) => {
              console.error('Error getting hostname:', error);
              // Ignore errors - directory might not exist
              resolve();
            },
            (exitCode: number) => {
              console.error('Error getting find command:', exitCode);
              resolve();
            }
          );
        }),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, 15000); // 15 second timeout
        })
      ]);
      
      const backupPaths = findOutput.trim().split('\n').filter(path => path.trim());
      
      // Get detailed info for each backup file
      for (const backupPath of backupPaths) {
        if (!backupPath.trim()) continue;
        
        try {
          // Get file size and modification time
          const statCommand = `stat -c '%s|%Y|%n' -- ${quoteShellArgument(backupPath)} 2>/dev/null || echo ""`;
          let statOutput = '';
          
          await Promise.race([
            new Promise<void>((resolve) => {
              void sshService.executeCommand(
                server,
                statCommand,
                (data: string) => {
                  statOutput += data;
                },
                () => resolve(),
                () => resolve()
              );
            }),
            new Promise<void>((resolve) => {
              setTimeout(() => resolve(), 5000); // 5 second timeout for stat
            })
          ]);
          
          const statParts = statOutput.trim().split('|');
          const fileName = backupPath.split('/').pop() ?? backupPath;
          
          if (statParts.length >= 2 && statParts[0] && statParts[1]) {
            const size = BigInt(statParts[0] ?? '0');
            const mtime = parseInt(statParts[1] ?? '0', 10);
            
            backups.push({
              container_id: ctId,
              server_id: server.id,
              hostname,
              backup_name: fileName,
              backup_path: backupPath,
              size,
              created_at: mtime > 0 ? new Date(mtime * 1000) : undefined,
              storage_name: 'local',
              storage_type: 'local',
            });
          } else {
            // If stat fails, still add the backup with minimal info
            backups.push({
              container_id: ctId,
              server_id: server.id,
              hostname,
              backup_name: fileName,
              backup_path: backupPath,
              size: undefined,
              created_at: undefined,
              storage_name: 'local',
              storage_type: 'local',
            });
          }
        } catch (error) {
          console.error('Error processing backup:', error);
          // Still try to add the backup even if stat fails
          const fileName = backupPath.split('/').pop() ?? backupPath;
          backups.push({
            container_id: ctId,
            server_id: server.id,
            hostname,
            backup_name: fileName,
            backup_path: backupPath,
            size: undefined,
            created_at: undefined,
            storage_name: 'local',
            storage_type: 'local',
          });
        }
      }
    } catch (error) {
      console.error(`Error discovering local backups for CT ${ctId}:`, error);
    }
    
    return backups;
  }

  /**
   * Discover backups in a mounted storage's configured dump directory.
   */
  async discoverStorageBackups(server: Server, storage: Storage, ctId: string, hostname: string): Promise<BackupData[]> {
    vmidSchema.parse(ctId);
    const sshService = getSSHExecutionService();
    const backups: BackupData[] = [];
    
    const dumpPath = getStorageDumpPath(storage);
    const findCommand = `timeout 10 find ${quoteShellArgument(dumpPath)} -type f -name "vzdump-lxc-${ctId}-*.tar*" 2>/dev/null`;
    let findOutput = '';
    
    console.log(`[BackupService] Discovering storage backups for CT ${ctId} on ${storage.name}`);
    
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          void sshService.executeCommand(
            server,
            findCommand,
            (data: string) => {
              findOutput += data;
            },
            (error: string) => {
              console.error('Error getting stat command:', error);
              resolve();
            },
            (exitCode: number) => {
              console.error('Error getting stat command:', exitCode);
              resolve();
            }
          );
        }),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            console.log(`[BackupService] Storage backup discovery timeout for ${storage.name}`);
            resolve();
          }, 15000); // 15 second timeout
        })
      ]);
      
      const backupPaths = findOutput.trim().split('\n').filter(path => path.trim());
      console.log(`[BackupService] Found ${backupPaths.length} backup files for CT ${ctId} on storage ${storage.name}`);
      
      // Get detailed info for each backup file
      for (const backupPath of backupPaths) {
        if (!backupPath.trim()) continue;
        
        try {
          const statCommand = `stat -c '%s|%Y|%n' -- ${quoteShellArgument(backupPath)} 2>/dev/null || echo ""`;
          let statOutput = '';
          
          await Promise.race([
            new Promise<void>((resolve) => {
              void sshService.executeCommand(
                server,
                statCommand,
                (data: string) => {
                  statOutput += data;
                },
                () => resolve(),
                () => resolve()
              );
            }),
            new Promise<void>((resolve) => {
              setTimeout(() => resolve(), 5000); // 5 second timeout for stat
            })
          ]);
          
          const statParts = statOutput.trim().split('|');
          const fileName = backupPath.split('/').pop() ?? backupPath;
          
          if (statParts.length >= 2 && statParts[0] && statParts[1]) {
            const size = BigInt(statParts[0] ?? '0');
            const mtime = parseInt(statParts[1] ?? '0', 10);
            
            backups.push({
              container_id: ctId,
              server_id: server.id,
              hostname,
              backup_name: fileName,
              backup_path: backupPath,
              size,
              created_at: mtime > 0 ? new Date(mtime * 1000) : undefined,
              storage_name: storage.name,
              storage_type: 'storage',
            });
            console.log(`[BackupService] Added storage backup: ${fileName} from ${storage.name}`);
          } else {
            // If stat fails, still add the backup with minimal info
            console.log(`[BackupService] Stat failed for ${fileName}, adding backup without size/date`);
            backups.push({
              container_id: ctId,
              server_id: server.id,
              hostname,
              backup_name: fileName,
              backup_path: backupPath,
              size: undefined,
              created_at: undefined,
              storage_name: storage.name,
              storage_type: 'storage',
            });
          }
        } catch (error) {
          console.error(`Error processing backup ${backupPath}:`, error);
          // Still try to add the backup even if stat fails
          const fileName = backupPath.split('/').pop() ?? backupPath;
          backups.push({
            container_id: ctId,
            server_id: server.id,
            hostname,
            backup_name: fileName,
            backup_path: backupPath,
            size: undefined,
            created_at: undefined,
            storage_name: storage.name,
            storage_type: 'storage',
          });
        }
      }
      
      console.log(`[BackupService] Total storage backups found for CT ${ctId} on ${storage.name}: ${backups.length}`);
    } catch (error) {
      console.error(`Error discovering storage backups for CT ${ctId} on ${storage.name}:`, error);
    }
    
    return backups;
  }

  /**
   * Login to PBS using stored credentials
   */
  async loginToPBS(server: Server, storage: Storage): Promise<boolean> {
    try {
      const credential = await getDatabase().getPBSCredential(server.id, storage.name);
      if (!credential) return false;
      const connection = getPBSConnection(credential, storage);
      // status works with both user passwords and API tokens; login does not.
      await runRemoteCommand(server, `${connection.environment} proxmox-backup-client status --repository ${quoteShellArgument(connection.repository)}`, 'Check PBS access', 30);
      return true;
    } catch { return false; }
  }

  async discoverPBSBackups(server: Server, storage: Storage, ctId: string, hostname: string): Promise<BackupData[]> {
    vmidSchema.parse(ctId);
    const credential = await getDatabase().getPBSCredential(server.id, storage.name);
    if (!credential) return [];
    const connection = getPBSConnection(credential, storage);
    const command = `${connection.environment} proxmox-backup-client snapshot list ${quoteShellArgument(`ct/${ctId}`)} --repository ${quoteShellArgument(connection.repository)}${connection.namespaceArgument} --output-format json`;
    const output = await runRemoteCommand(server, command, 'List PBS snapshots', 60);
    const snapshots = pbsSnapshotListSchema.parse(JSON.parse(output));
    return snapshots.map(snapshot => {
      if (snapshot['backup-id'] !== ctId || snapshot['backup-type'] !== 'ct') throw new Error('PBS returned a snapshot for another container');
      const date = new Date(snapshot['backup-time'] * 1000);
      const snapshotPath = parseLXCSnapshot(`ct/${ctId}/${date.toISOString().replace('.000Z', 'Z')}`, ctId);
      return {
        container_id: ctId, server_id: server.id, hostname,
        backup_name: date.toISOString().replace('.000Z', 'Z'),
        backup_path: `pbs://${connection.repository}/${snapshotPath}`,
        size: snapshot.size === undefined ? undefined : BigInt(snapshot.size),
        created_at: date, storage_name: storage.name, storage_type: 'pbs',
      };
    });
  }

  /** Discover across supported storages. */
  async discoverAllBackupsForContainer(server: Server, ctId: string, hostname: string): Promise<BackupData[]> {
    const allBackups: BackupData[] = [];
    
    try {
      // Get server hostname to filter storages
      const serverHostname = await this.getServerHostname(server);
      const normalizedHostname = serverHostname.trim().toLowerCase();
      console.log(`[BackupService] Discovering backups for server ${server.name} (hostname: ${serverHostname}, normalized: ${normalizedHostname})`);
      
      // Get all backup-capable storages (force refresh to get latest node assignments)
      const storageService = getStorageService();
      const allStorages = await storageService.getBackupStorages(server, true); // Force refresh
      
      console.log(`[BackupService] Found ${allStorages.length} backup-capable storages total`);
      
      // Filter storages by node hostname matching
      const applicableStorages = allStorages.filter(storage => {
        // If storage has no nodes specified, it's available on all nodes
        if (!storage.nodes || storage.nodes.length === 0) {
          console.log(`[BackupService] Storage ${storage.name} has no nodes specified, including it`);
          return true;
        }
        
        // Normalize all nodes for comparison
        const normalizedNodes = storage.nodes.map(node => node.trim().toLowerCase());
        const isApplicable = normalizedNodes.includes(normalizedHostname);
        
        if (!isApplicable) {
          console.log(`[BackupService] EXCLUDING Storage ${storage.name} (nodes: ${storage.nodes.join(', ')}) - not applicable for hostname: ${serverHostname}`);
        } else {
          console.log(`[BackupService] INCLUDING Storage ${storage.name} (nodes: ${storage.nodes.join(', ')}) - applicable for hostname: ${serverHostname}`);
        }
        
        return isApplicable;
      });
      
      console.log(`[BackupService] Filtered to ${applicableStorages.length} applicable storages for ${serverHostname}`);
      
      // Discover local backups
      const localBackups = await this.discoverLocalBackups(server, ctId, hostname);
      allBackups.push(...localBackups);
      
      // Discover backups from each applicable storage
      for (const storage of applicableStorages) {
        try {
          if (storage.type === 'pbs') {
            // PBS storage
            const pbsBackups = await this.discoverPBSBackups(server, storage, ctId, hostname);
            allBackups.push(...pbsBackups);
          } else {
            // Regular storage (dir, nfs, etc.)
            const storageBackups = await this.discoverStorageBackups(server, storage, ctId, hostname);
            allBackups.push(...storageBackups);
          }
        } catch (error) {
          console.error(`[BackupService] Error discovering backups from storage ${storage.name}:`, error);
          // Continue with other storages
        }
      }
      
      console.log(`[BackupService] Total backups discovered for CT ${ctId}: ${allBackups.length}`);
    } catch (error) {
      console.error(`Error discovering backups for container ${ctId}:`, error);
    }
    
    return allBackups;
  }

  /**
   * Discover backups for all installed scripts with container_id
   */
  async discoverAllBackups(): Promise<void> {
    const db = getDatabase();
    const scripts = await db.getAllInstalledScripts();
    
    // Filter scripts that have container_id and server_id
    const scriptsWithContainers = scripts.filter(
      (script: any) => script.container_id && script.server_id && script.server
    );
    
    // Clear all existing backups first to ensure we start fresh
    console.log('[BackupService] Clearing all existing backups before rediscovery...');
    const allBackups = await db.getAllBackups();
    for (const backup of allBackups) {
      await db.deleteBackupsForContainer(backup.container_id, backup.server_id);
    }
    console.log('[BackupService] Cleared all existing backups');
    
    for (const script of scriptsWithContainers) {
      if (!script.container_id || !script.server_id || !script.server) continue;
      
      const containerId = script.container_id;
      const server = script.server as Server;
      
      try {
        // Get hostname from LXC config if available, otherwise use script name
        let hostname = script.script_name ?? `CT-${script.container_id}`;
        try {
          const lxcConfig = await db.getLXCConfigByScriptId(script.id);
          if (lxcConfig?.hostname) {
            hostname = lxcConfig.hostname;
          }
        } catch (error) {
          console.error('Error getting LXC config:', error);
          // LXC config might not exist, use script name
          console.debug(`No LXC config found for script ${script.id}, using script name as hostname`);
        }
        
        console.log(`[BackupService] Discovering backups for script ${script.id}, CT ${containerId} on server ${server.name}`);
        
        // Discover backups for this container
        const backups = await this.discoverAllBackupsForContainer(
          server,
          containerId,
          hostname
        );
        
        console.log(`[BackupService] Found ${backups.length} backups for CT ${containerId} on server ${server.name}`);
        
        // Save discovered backups
        for (const backup of backups) {
          await db.createOrUpdateBackup(backup);
        }
      } catch (error) {
        console.error(`Error discovering backups for script ${script.id} (CT ${script.container_id}):`, error);
      }
    }
  }
}

// Singleton instance
let backupServiceInstance: BackupService | null = null;

export function getBackupService(): BackupService {
  backupServiceInstance ??= new BackupService();
  return backupServiceInstance;
}

