const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

/** Credential stores by exact file name: package-registry tokens, git/HTTP credentials, CLI OAuth logins (P7-S4). */
const CREDENTIAL_NAMES = new Set([
  'credentials.json', '.credentials.json', '.npmrc', '.yarnrc.yml', '.pypirc', '.netrc', '_netrc',
  '.git-credentials', '.pgpass', '.htpasswd',
]);

/** Folders whose every file is a credential (`.ssh/config`, `.aws/credentials`, …). */
const CREDENTIAL_DIRS = new Set(['.ssh', '.aws', '.gnupg']);

/** Files that typically hold secrets: never served by the file API, copied on import or committed by the studio. */
export function isSensitivePath(relativePath: string): boolean {
  const segments = relativePath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const name = segments.at(-1) ?? '';
  if (name === '.env' || (name.startsWith('.env.') && !SAFE_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix)))) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(name)) return true;
  if (CREDENTIAL_NAMES.has(name) || segments.slice(0, -1).some((segment) => CREDENTIAL_DIRS.has(segment))) return true;
  return /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name);
}
