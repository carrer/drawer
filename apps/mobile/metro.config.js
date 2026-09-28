// Expo's default config is monorepo-aware since SDK 52: it watches the workspace
// root (so edits in packages/shared hot-reload) and resolves from both
// node_modules roots on its own.
//
// Don't add `resolver.disableHierarchicalLookup = true` back. npm legitimately
// nests packages (e.g. node_modules/expo/node_modules/expo-modules-core), and
// with hierarchical lookup off Metro can't see them. The app then dies on
// launch with "Unable to resolve module expo-modules-core".
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
