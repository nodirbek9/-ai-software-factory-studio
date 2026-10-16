import path from 'node:path';

const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

/** Files that typically hold secrets: never served by the file API, copied on import or committed by the studio. */
export function isSensitivePath(relativePath: string): boolean {
  const name = path.basename(relativePath.replace(/\\/g, '/')).toLowerCase();
  if (name === '.env' || (name.startsWith('.env.') && !SAFE_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix)))) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(name)) return true;
  return /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name);
}
