import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { env } from "~/env";
import { existsSync, createWriteStream } from "fs";
import stripAnsi from "strip-ansi";
import { z } from 'zod';
import { getApplicationUpdateSource } from '~/server/services/applicationUpdateSource';

const applicationReleaseSchema = z.object({
  tag_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  published_at: z.string(), draft: z.boolean().optional().default(false),
});

interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  body: string;
  prerelease: boolean;
}

// Helper function to fetch from GitHub API with optional authentication
async function fetchGitHubAPI(url: string) {
  const headers: HeadersInit = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'ProxmoxVE-Local'
  };
  
  // Add authentication header if token is available
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `token ${env.GITHUB_TOKEN}`;
  }
  
  return fetch(url, { headers });
}

export const versionRouter = createTRPCRouter({
  // Get current local version
  getCurrentVersion: publicProcedure
    .query(async () => {
      try {
        const versionPath = join(process.cwd(), 'VERSION');
        const version = await readFile(versionPath, 'utf-8');
        return {
          success: true,
          version: version.trim()
        };
      } catch (error) {
        console.error('Error reading VERSION file:', error);
        return {
          success: false,
          error: 'Failed to read VERSION file',
          version: null
        };
      }
    }),

  getLatestRelease: publicProcedure
    .query(async () => {
      try {
        const allowPrerelease = env.ALLOW_PRERELEASE === 'true';
        let release: GitHubRelease;

        if (allowPrerelease) {
          const response = await fetchGitHubAPI(`${getApplicationUpdateSource().api}/releases`);
          if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
          const releases: GitHubRelease[] = await response.json();
          const sorted = releases.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
          if (!sorted[0]) throw new Error('No releases found');
          release = sorted[0];
        } else {
          const response = await fetchGitHubAPI(`${getApplicationUpdateSource().api}/releases/latest`);
          if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
          release = await response.json();
        }
        
        return {
          success: true,
          release: {
            tagName: release.tag_name,
            name: release.name,
            publishedAt: release.published_at,
            htmlUrl: release.html_url
          }
        };
      } catch (error) {
        console.error('Error fetching latest release:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch latest release',
          release: null
        };
      }
    }),


  getVersionStatus: publicProcedure
    .query(async () => {
      try {
        const versionPath = join(process.cwd(), 'VERSION');
        const currentVersion = (await readFile(versionPath, 'utf-8')).trim();

        const allowPrerelease = env.ALLOW_PRERELEASE === 'true';
        let release: GitHubRelease;

        if (allowPrerelease) {
          const response = await fetchGitHubAPI(`${getApplicationUpdateSource().api}/releases`);
          if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
          const releases: GitHubRelease[] = await response.json();
          const sorted = releases.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
          if (!sorted[0]) throw new Error('No releases found');
          release = sorted[0];
        } else {
          const response = await fetchGitHubAPI(`${getApplicationUpdateSource().api}/releases/latest`);
          if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
          release = await response.json();
        }
        const latestVersion = release.tag_name.replace('v', ''); 
        

        const isUpToDate = currentVersion === latestVersion;
        
        return {
          success: true,
          currentVersion,
          latestVersion,
          isUpToDate,
          updateAvailable: !isUpToDate,
          releaseInfo: {
            tagName: release.tag_name,
            name: release.name,
            publishedAt: release.published_at,
            htmlUrl: release.html_url,
            body: release.body
          }
        };
      } catch (error) {
        console.error('Error checking version status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check version status',
          currentVersion: null,
          latestVersion: null,
          isUpToDate: false,
          updateAvailable: false,
          releaseInfo: null
        };
      }
    }),

  // Get all releases for release notes
  getAllReleases: publicProcedure
    .query(async () => {
      try {
        const response = await fetchGitHubAPI(`${getApplicationUpdateSource().api}/releases`);
        
        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status}`);
        }
        
        const releases: GitHubRelease[] = await response.json();
        
        // Sort by published date (newest first)
        const sortedReleases = releases
          .filter(release => !release.tag_name.includes('beta') && !release.tag_name.includes('alpha'))
          .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
        
        return {
          success: true,
          releases: sortedReleases.map(release => ({
            tagName: release.tag_name,
            name: release.name,
            publishedAt: release.published_at,
            htmlUrl: release.html_url,
            body: release.body
          }))
        };
      } catch (error) {
        console.error('Error fetching all releases:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch releases',
          releases: []
        };
      }
    }),

  // Get update logs from the log file
  getUpdateLogs: publicProcedure
    .query(async () => {
      try {
        const logPath = join(process.cwd(), 'update.log');
        
        if (!existsSync(logPath)) {
          return {
            success: true,
            logs: [],
            isComplete: false,
            logFileModifiedTime: null
          };
        }

        // Get log file modification time for session validation
        let logFileModifiedTime: number | null = null;
        try {
          const stats = await stat(logPath);
          logFileModifiedTime = stats.mtimeMs;
        } catch (statError) {
          // If we can't get stats, continue without timestamp
          console.warn('Could not get log file stats:', statError);
        }

        const logs = await readFile(logPath, 'utf-8');
        const logLines = logs.split('\n')
          .filter(line => line.trim())
          .map(line => stripAnsi(line)); // Strip ANSI color codes
        
        // Check if update is complete by looking for completion indicators
        const isComplete = logLines.some(line => 
          line.includes('Update complete') || 
          line.includes('Server restarting') ||
          line.includes('npm start') ||
          line.includes('Restarting server') ||
          line.includes('Server started') ||
          line.includes('Ready on http') ||
          line.includes('Application started') ||
          line.includes('Service enabled and started successfully') ||
          line.includes('Service is running') ||
          line.includes('Update completed successfully')
        );

        return {
          success: true,
          logs: logLines,
          isComplete,
          logFileModifiedTime
        };
      } catch (error) {
        console.error('Error reading update logs:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read update logs',
          logs: [],
          isComplete: false,
          logFileModifiedTime: null
        };
      }
    }),

  // Execute update script
  executeUpdate: publicProcedure
    .mutation(async () => {
      try {
        const updateScriptPath = join(process.cwd(), 'update.sh');
        const logPath = join(process.cwd(), 'update.log');
        
        // Clear/create the log file
        await writeFile(logPath, '', 'utf-8');
        
        const source = getApplicationUpdateSource();
        const bootstrap = await readFile(updateScriptPath, 'utf8');
        if (!bootstrap.includes('pve_local_update_source')) throw new Error('Local updater does not support fork-aware updates');
        const allowPrerelease = env.ALLOW_PRERELEASE === 'true';
        const response = await fetchGitHubAPI(`${source.api}/releases${allowPrerelease ? '' : '/latest'}`);
        if (!response.ok) throw new Error(`No application release available from ${source.repository} (HTTP ${response.status})`);
        const payload: unknown = await response.json();
        const release = allowPrerelease
          ? applicationReleaseSchema.array().parse(payload).filter(item => !item.draft).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0]
          : applicationReleaseSchema.parse(payload);
        if (!release) throw new Error('No application releases found');
        const tag = release.tag_name;
        await writeFile(logPath, `[INFO] Updating application from ${source.repository} release ${tag}\n`, { flag: 'a' });
        // Spawn the update script as a detached process using nohup
        // This allows it to run independently and kill the parent Node.js process
        // Redirect output to log file
        const child = spawn('bash', [updateScriptPath, '--version', tag], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          detached: true,
          env: { ...process.env, APP_UPDATE_REPOSITORY: source.repository, APP_UPDATE_BRANCH: source.branch }
        });

        // Capture stdout and stderr to log file
        const logStream = createWriteStream(logPath, { flags: 'a' });
        child.stdout?.pipe(logStream);
        child.stderr?.pipe(logStream);
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });

        // Unref the child process so it doesn't keep the parent alive
        child.unref();

        // Immediately return success since we can't wait for completion
        // The script will handle its own logging and restart
        return {
          success: true,
          message: 'Update started in background. The server will restart automatically when complete.',
          output: '',
          error: ''
        };
      } catch (error) {
        console.error('Error executing update script:', error);
        return {
          success: false,
          message: `Failed to execute update script: ${error instanceof Error ? error.message : 'Unknown error'}`,
          output: '',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    })
});
