import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Resolve an existing script without allowing sibling directories or symlinks
 * to escape the script root. Call before reading, transferring, or executing it.
 * @param {string} scriptPath
 * @param {string} scriptsDirectory
 * @returns {string}
 */
export function resolveScriptPath(scriptPath, scriptsDirectory) {
  const root = realpathSync(scriptsDirectory);
  const script = realpathSync(resolve(scriptPath));
  const relativePath = relative(root, script);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Script path is not within the allowed scripts directory');
  }
  if (!statSync(script).isFile()) {
    throw new Error('Script path must be a file');
  }
  return script;
}
