/**
 * Host-owned platform observation used by activation preflight.
 *
 * Keeping this behind a zero-argument adapter lets Linux CI exercise the
 * non-Linux refusal without turning platform into caller-controlled
 * configuration or activation evidence.
 */
export function observeHostPlatform(): NodeJS.Platform {
  return process.platform;
}
