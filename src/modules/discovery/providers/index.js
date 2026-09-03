// =============================================================================
// providers/index.js — Provider registry.
// =============================================================================
const { config } = require('../discovery.config');
const { assertValidProvider } = require('./imageSearchProvider');
const serperProvider = require('./serper.provider');

const registry = new Map([[serperProvider.name, assertValidProvider(serperProvider)]]);

/**
 * Resolve the configured provider. Throws at boot-time require() if the
 * configured name has no adapter, rather than failing on the first request.
 */
function getProvider(name = config.providerName) {
  const provider = registry.get(name);
  if (!provider) {
    throw new Error(
      `Unknown search provider "${name}". Registered: ${[...registry.keys()].join(', ') || '(none)'}`
    );
  }
  return provider;
}

module.exports = { getProvider };
