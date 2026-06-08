// Typed access to edge-function secrets. Secrets are server-side only.

export function optionalEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

export function requireEnv(name: string): string {
  const v = optionalEnv(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
