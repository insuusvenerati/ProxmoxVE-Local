// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getApplicationUpdateSource } from './applicationUpdateSource';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const temporaryDirectories: string[] = [];
const makeDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'pve-updater-test-'));
  temporaryDirectories.push(directory);
  return directory;
};
const shellPath = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
afterEach(() => temporaryDirectories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('application release source', () => {
  it('defaults to this fork independently of the script catalogue', () => {
    expect(getApplicationUpdateSource({ REPO_URL: 'https://github.com/community-scripts/ProxmoxVE' }).repository).toBe('insuusvenerati/ProxmoxVE-Local');
  });
  it('uses a configured repository for both API and bootstrap', () => {
    const source = getApplicationUpdateSource({ APP_UPDATE_REPOSITORY: 'example/renamed-fork', APP_UPDATE_BRANCH: 'feature/updates' });
    expect(source.api).toBe('https://api.github.com/repos/example/renamed-fork');
    expect(source.raw).toBe('https://raw.githubusercontent.com/example/renamed-fork/feature%2Fupdates');
  });
  it.each(['https://github.com/a/b', 'a/b/extra', 'a/../b', 'a/repo.git', 'a/repo;id'])('rejects source %j', repository => {
    expect(() => getApplicationUpdateSource({ APP_UPDATE_REPOSITORY: repository })).toThrow();
  });
});

describe.skipIf(!existsSync(shell))('Bash updater source contract', () => {
  it('aborts failed release preparation before stopping or modifying the application', () => {
    const directory = makeDirectory();
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(join(directory, 'server.js'), '');
    const mutation = join(directory, 'mutation');
    const script = 'source "$1"; init_log() { :; }; sleep() { :; }; check_dependencies() { :; }; load_github_token() { :; }; check_service() { return 1; }; get_release() { printf "v1|url"; }; download_release() { return 1; }; backup_data() { touch "$MUTATION_FILE"; }; stop_application() { touch "$MUTATION_FILE"; }; clear_original_directory() { touch "$MUTATION_FILE"; }; if main --relocated; then exit 0; else exit 1; fi';
    const result = spawnSync(shell, ['-c', script, 'test', shellPath(resolve('update-engine.sh')), shellPath(mutation)], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, APP_UPDATE_REPOSITORY: 'example/fork', APP_UPDATE_BRANCH: 'main', MUTATION_FILE: shellPath(mutation) },
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(mutation)).toBe(false);
  });
  it.each(['update-source.sh', 'update.sh', 'update-engine.sh', 'pre-release-updater.sh'])('parses %s', file => {
    expect(spawnSync(shell, ['-n', resolve(file)], { encoding: 'utf8' }).status).toBe(0);
  });
  it('loads quoted settings without executing .env contents', () => {
    const directory = makeDirectory();
    const envFile = join(directory, '.env');
    writeFileSync(envFile, 'APP_UPDATE_REPOSITORY="example/fork"\nAPP_UPDATE_BRANCH="test/branch"\nUNRELATED=$(exit 99)\n');
    const result = spawnSync(shell, ['-c', 'source "$1"; pve_local_update_source "$2"; printf "%s|%s" "$APP_UPDATE_REPOSITORY" "$APP_UPDATE_BRANCH"', 'test', shellPath(resolve('update-source.sh')), shellPath(envFile)], {
      encoding: 'utf8', env: { ...process.env, APP_UPDATE_REPOSITORY: '', APP_UPDATE_BRANCH: '' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('example/fork|test/branch');
  });
  it.each([true, false])('bootstrap enforces fork-aware engine support (%s)', compatible => {
    const directory = makeDirectory();
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    for (const file of ['update.sh', 'update-source.sh']) copyFileSync(resolve(file), join(directory, file));
    const downloaded = join(directory, 'downloaded-engine');
    writeFileSync(downloaded, `#!/bin/bash\n${compatible ? '# PVE_LOCAL_UPDATE_SOURCE_V1\n' : ''}printf '%s' "$APP_UPDATE_REPOSITORY" > "$RESULT_FILE"\n`);
    writeFileSync(join(directory, 'update-engine.sh'), '#!/bin/bash\nexit 99\n');
    writeFileSync(join(directory, 'UPDATER_VERSION'), '0');
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$REQUEST_FILE"\nif [[ "$*" == *UPDATER_VERSION* ]]; then printf "1\\n200"; else while [ "$1" != "-o" ]; do shift; done; cp "$DOWNLOAD_ENGINE" "$2"; fi\n', { mode: 0o755 });
    const resultFile = join(directory, 'result');
    const requestFile = join(directory, 'requests');
    const result = spawnSync(shell, ['-c', 'export PATH="$1:$PATH"; exec bash ./update.sh --version v1.0.0', 'test', shellPath(bin)], {
      cwd: directory, encoding: 'utf8', env: {
        ...process.env, APP_UPDATE_REPOSITORY: 'example/fork', APP_UPDATE_BRANCH: 'maintenance',
        RESULT_FILE: shellPath(resultFile), DOWNLOAD_ENGINE: shellPath(downloaded), REQUEST_FILE: shellPath(requestFile),
      },
    });
    if (compatible) {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(resultFile, 'utf8')).toBe('example/fork');
    } else {
      expect(result.status).not.toBe(0);
      expect(existsSync(resultFile)).toBe(false);
    }
    const requests = readFileSync(requestFile, 'utf8');
    expect(requests).toContain('https://raw.githubusercontent.com/example/fork/maintenance/');
    expect(requests).not.toContain('community-scripts');
  });
});
