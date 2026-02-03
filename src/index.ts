import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync } from 'fs';

const agent = await createAgent({
  name: 'package-intel',
  version: '1.0.0',
  description: 'Cross-ecosystem package intelligence for developer agents. Query npm, PyPI, and crates.io in one place.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPERS ===
async function fetchNpm(name: string) {
  const [meta, downloads] = await Promise.all([
    fetch(`https://registry.npmjs.org/${name}`).then(r => r.ok ? r.json() : null),
    fetch(`https://api.npmjs.org/downloads/point/last-week/${name}`).then(r => r.ok ? r.json() : null)
  ]);
  if (!meta) return null;
  return {
    ecosystem: 'npm',
    name: meta.name,
    description: meta.description,
    version: meta['dist-tags']?.latest,
    versions: Object.keys(meta.versions || {}).length,
    downloads: downloads?.downloads ?? null,
    repository: meta.repository?.url,
    homepage: meta.homepage,
    license: meta.license,
    modified: meta.time?.modified,
    created: meta.time?.created,
  };
}

async function fetchPypi(name: string) {
  const res = await fetch(`https://pypi.org/pypi/${name}/json`);
  if (!res.ok) return null;
  const data = await res.json();
  const info = data.info;
  return {
    ecosystem: 'pypi',
    name: info.name,
    description: info.summary,
    version: info.version,
    versions: Object.keys(data.releases || {}).length,
    author: info.author,
    authorEmail: info.author_email,
    homepage: info.home_page || info.project_url,
    license: info.license,
    requires_python: info.requires_python,
    keywords: info.keywords,
  };
}

async function fetchCrates(name: string) {
  const res = await fetch(`https://crates.io/api/v1/crates/${name}`, {
    headers: { 'User-Agent': 'package-intel/1.0' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const crate = data.crate;
  return {
    ecosystem: 'crates',
    name: crate.name,
    description: crate.description,
    version: crate.newest_version,
    versions: crate.max_version ? null : crate.versions?.length,
    downloads: crate.downloads,
    recent_downloads: crate.recent_downloads,
    repository: crate.repository,
    homepage: crate.homepage,
    documentation: crate.documentation,
    created: crate.created_at,
    updated: crate.updated_at,
  };
}

// === FREE ENDPOINT ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - popular packages across npm, PyPI, and crates.io',
  input: z.object({}),
  handler: async () => {
    const [react, requests, serde] = await Promise.all([
      fetchNpm('react'),
      fetchPypi('requests'),
      fetchCrates('serde')
    ]);
    return {
      output: {
        message: 'Package Intel - Cross-ecosystem package data for developer agents',
        ecosystems: ['npm', 'pypi', 'crates'],
        samples: {
          npm: react ? { name: react.name, version: react.version, downloads: react.downloads } : null,
          pypi: requests ? { name: requests.name, version: requests.version } : null,
          crates: serde ? { name: serde.name, version: serde.version, downloads: serde.downloads } : null,
        },
        endpoints: {
          free: ['overview'],
          paid: ['npm-lookup', 'pypi-lookup', 'crates-lookup', 'cross-ecosystem', 'dependency-check']
        },
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 1: NPM Lookup ($0.001) ===
addEntrypoint({
  key: 'npm-lookup',
  description: 'Look up any npm package - versions, downloads, metadata',
  input: z.object({ package: z.string().describe('NPM package name') }),
  price: "1000",
  handler: async (ctx) => {
    const data = await fetchNpm(ctx.input.package);
    if (!data) {
      return { output: { error: 'Package not found', package: ctx.input.package, ecosystem: 'npm' } };
    }
    return { output: data };
  },
});

// === PAID ENDPOINT 2: PyPI Lookup ($0.001) ===
addEntrypoint({
  key: 'pypi-lookup',
  description: 'Look up any PyPI package - versions, author, metadata',
  input: z.object({ package: z.string().describe('PyPI package name') }),
  price: "1000",
  handler: async (ctx) => {
    const data = await fetchPypi(ctx.input.package);
    if (!data) {
      return { output: { error: 'Package not found', package: ctx.input.package, ecosystem: 'pypi' } };
    }
    return { output: data };
  },
});

// === PAID ENDPOINT 3: Crates Lookup ($0.001) ===
addEntrypoint({
  key: 'crates-lookup',
  description: 'Look up any Rust crate - versions, downloads, metadata',
  input: z.object({ crate: z.string().describe('Crate name') }),
  price: "1000",
  handler: async (ctx) => {
    const data = await fetchCrates(ctx.input.crate);
    if (!data) {
      return { output: { error: 'Crate not found', crate: ctx.input.crate, ecosystem: 'crates' } };
    }
    return { output: data };
  },
});

// === PAID ENDPOINT 4: Cross-Ecosystem Search ($0.002) ===
addEntrypoint({
  key: 'cross-ecosystem',
  description: 'Search for a package across npm, PyPI, and crates.io simultaneously',
  input: z.object({ query: z.string().describe('Package name to search across all ecosystems') }),
  price: "2000",
  handler: async (ctx) => {
    const q = ctx.input.query;
    const [npm, pypi, crates] = await Promise.all([
      fetchNpm(q),
      fetchPypi(q),
      fetchCrates(q)
    ]);
    const results = [npm, pypi, crates].filter(Boolean);
    return {
      output: {
        query: q,
        found: results.length,
        results,
        searchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 5: Dependency Check ($0.003) ===
addEntrypoint({
  key: 'dependency-check',
  description: 'Get detailed dependency info for npm packages',
  input: z.object({ package: z.string().describe('NPM package name') }),
  price: "3000",
  handler: async (ctx) => {
    const res = await fetch(`https://registry.npmjs.org/${ctx.input.package}`);
    if (!res.ok) {
      return { output: { error: 'Package not found', package: ctx.input.package } };
    }
    const data = await res.json();
    const latest = data['dist-tags']?.latest;
    const latestVersion = data.versions?.[latest];
    return {
      output: {
        package: data.name,
        version: latest,
        dependencies: latestVersion?.dependencies || {},
        devDependencies: latestVersion?.devDependencies || {},
        peerDependencies: latestVersion?.peerDependencies || {},
        engines: latestVersion?.engines || {},
        dependencyCount: Object.keys(latestVersion?.dependencies || {}).length,
        devDependencyCount: Object.keys(latestVersion?.devDependencies || {}).length,
        checkedAt: new Date().toISOString(),
      }
    };
  },
});

// === ANALYTICS ENDPOINTS ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({ windowMs: z.number().optional() }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) return { output: { error: 'Analytics not available' } };
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      }
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({ windowMs: z.number().optional(), limit: z.number().optional().default(50) }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) return { output: { transactions: [] } };
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

// Serve icon (SVG)
app.get('/icon.svg', async (c) => {
  try {
    const icon = readFileSync('./icon.svg');
    return new Response(icon, { headers: { 'Content-Type': 'image/svg+xml' } });
  } catch {
    return c.text('Icon not found', 404);
  }
});

app.get('/icon.png', (c) => c.redirect('/icon.svg'));

// ERC-8004 registration file
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.BASE_URL || 'https://package-intel-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "package-intel",
    description: "Cross-ecosystem package intelligence. Query npm, PyPI, and crates.io. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.svg`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Package Intel running on port ${port}`);

export default { port, fetch: app.fetch };
