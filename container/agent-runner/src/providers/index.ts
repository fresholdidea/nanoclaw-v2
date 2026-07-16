// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.

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
  loadProvider('agy'),
]);
