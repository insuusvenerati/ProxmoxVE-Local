// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveScriptPath } from './scriptPath.js';

describe('script execution path boundary', () => {
  let directory: string;
  let root: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pve-script-path-'));
    root = join(directory, 'scripts');
    mkdirSync(join(root, 'ct'), { recursive: true });
    mkdirSync(join(directory, 'scripts-other'));
    writeFileSync(join(root, 'ct', 'example.sh'), 'echo example');
    writeFileSync(join(directory, 'scripts-other', 'outside.sh'), 'echo outside');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('accepts an existing nested script', () => {
    const script = join(root, 'ct', 'example.sh');
    expect(resolveScriptPath(script, root)).toBe(realpathSync(script));
  });

  it('rejects a sibling directory with the same prefix', () => {
    expect(() => resolveScriptPath(join(directory, 'scripts-other', 'outside.sh'), root)).toThrow(/allowed scripts directory/);
  });

  it('rejects traversal outside the scripts root', () => {
    expect(() => resolveScriptPath(join(root, '..', 'scripts-other', 'outside.sh'), root)).toThrow();
  });

  it('rejects a directory and a missing file', () => {
    expect(() => resolveScriptPath(root, root)).toThrow();
    expect(() => resolveScriptPath(join(root, 'ct'), root)).toThrow(/must be a file/);
    expect(() => resolveScriptPath(join(root, 'missing.sh'), root)).toThrow();
  });

  it('rejects a directory symlink escaping the scripts root', () => {
    const link = join(root, 'escape');
    symlinkSync(join(directory, 'scripts-other'), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveScriptPath(join(link, 'outside.sh'), root)).toThrow(/allowed scripts directory/);
  });

  it('accepts a script when the scripts root itself is a symlink', () => {
    const linkedRoot = join(directory, 'linked-scripts');
    symlinkSync(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(resolveScriptPath(join(linkedRoot, 'ct', 'example.sh'), linkedRoot)).toBe(realpathSync(join(root, 'ct', 'example.sh')));
  });
});
