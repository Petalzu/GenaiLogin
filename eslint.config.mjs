import globals from "globals";

export default [{
    files: ["extension.js", "auth.js", "auth-forms.js", "browser-auth.js", "dashboard.js", "stats.js", "bridge-stream.js", "copilot-config.js", "copilot-models.js", "upstream.js", "image-mcp.js", "esbuild.cjs", "test/extension.test.js", "test/stats.test.js", "test/bridge-stream.test.cjs", "test/local-access.test.cjs", "test/copilot-models.test.cjs", "test/image-mcp.test.cjs", "test/browser-auth.test.cjs", "test/history.test.cjs"],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
        },

        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "no-const-assign": "warn",
        "no-this-before-super": "warn",
        "no-undef": "warn",
        "no-unreachable": "warn",
        "no-unused-vars": "warn",
        "constructor-super": "warn",
        "valid-typeof": "warn",
    },
}];