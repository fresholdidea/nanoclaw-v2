// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending a line below.
//
// Dynamic import + try/catch: a provider whose optional runtime dep isn't
// installed (e.g. a per-agent image built before /add-opencode ran) shouldn't
// crash agent-runner startup for groups using a different provider. If an
// unregistered provider is later selected, factory.ts surfaces a clear error.

async function loadProvider(name: string): Promise<void> {
  try {
    await import(`./${name}.js`);
  } catch (err) {
    console.error(`[providers] Skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await Promise.all([
  loadProvider('claude'),
  loadProvider('mock'),
  loadProvider('opencode'),
]);
