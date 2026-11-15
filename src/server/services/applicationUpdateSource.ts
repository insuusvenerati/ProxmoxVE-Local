const DEFAULT_REPOSITORY = 'insuusvenerati/ProxmoxVE-Local';

/** Application releases are independent from the community script catalogue. */
export function getApplicationUpdateSource(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const repository = environment.APP_UPDATE_REPOSITORY?.length ? environment.APP_UPDATE_REPOSITORY : DEFAULT_REPOSITORY;
  const branch = environment.APP_UPDATE_BRANCH?.length ? environment.APP_UPDATE_BRANCH : 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) || repository.endsWith('.git')) throw new Error('Invalid APP_UPDATE_REPOSITORY; use owner/repository');
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) throw new Error('Invalid APP_UPDATE_BRANCH');
  return {
    repository, branch,
    api: `https://api.github.com/repos/${repository}`,
    raw: `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}`,
  };
}
