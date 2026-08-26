export {};

const rootApi = await import('@wtm/core');
if ('runGit' in rootApi) throw new Error('@wtm/core exposed runGit');

try {
  const unsafeSubpath = '@wtm/core/git';
  await import(unsafeSubpath);
  throw new Error('@wtm/core/git remained publicly importable');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    throw error;
  }
}
