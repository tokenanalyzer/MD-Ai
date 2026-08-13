const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Workspace packages consumed directly from source (packages/client-core,
// packages/shared-types — package.json "main"/"types" point at src/index.ts,
// no build step) are written under tsconfig.base.json's
// "moduleResolution": "NodeNext", which requires relative imports to use the
// *compiled* ".js" extension even though the source files are ".ts"
// (e.g. packages/client-core/src/index.ts has `export * from "./platform.js"`,
// and only platform.ts exists on disk). tsc resolves this correctly — it's
// how NodeNext is specified to work, and how the real emitted JS resolves at
// runtime — but Metro's resolver has no built-in knowledge of the mapping, so
// it looks for a literal "platform.js", finds none, and fails with
// "Unable to resolve". Retry unresolved relative ".js" specifiers as
// ".ts"/".tsx"; this is Metro's own documented pattern for this exact case:
// https://facebook.github.io/metro/docs/resolution/#resolverequest-custom-resolver
config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
      const withoutJsExt = moduleName.slice(0, -3);
      for (const ext of [".ts", ".tsx"]) {
        try {
          return context.resolveRequest(context, withoutJsExt + ext, platform);
        } catch {
          // try the next candidate extension
        }
      }
    }
    throw error;
  }
};

module.exports = config;
