/** Provider Settings is development-only and must not mount in production. */
export const KEY_SETUP_PLUGIN = 'gev-key-setup';

/**
 * Drop the dev-only key setup plugin. Order of the remaining plugins is kept.
 * @param {Array<object>} plugins
 */
export function productionPlugins(plugins = []) {
  return plugins.filter((plugin) => plugin?.name !== KEY_SETUP_PLUGIN);
}

/**
 * Give each provider the Vite preview hook it already implements.
 * `configurePreviewServer` wins when both hooks exist.
 * @param {{ middlewares: { use: Function }, config?: object, httpServer?: object }} server
 * @param {Array<object>} plugins
 */
export function mountProviderPlugins(server, plugins = []) {
  const mounted = [];
  for (const plugin of productionPlugins(plugins)) {
    const hook = plugin.configurePreviewServer || plugin.configureServer;
    if (typeof hook !== 'function') continue;
    hook(server);
    mounted.push(plugin);
  }
  return mounted;
}

/**
 * Run a provider's optional `shutdown()` hook, otherwise its `closeBundle` hook.
 * @param {object} plugin
 */
export function shutdownProviderPlugin(plugin) {
  if (typeof plugin?.shutdown === 'function') return plugin.shutdown();
  if (typeof plugin?.closeBundle === 'function') return plugin.closeBundle();
  return undefined;
}
