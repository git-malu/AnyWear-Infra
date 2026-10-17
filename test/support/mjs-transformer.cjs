// Jest runs the CDK app as CommonJS. The versioned stage-contracts package is
// plain ESM, so this test-only transformer compiles that one `.mjs` entrypoint to
// CommonJS with the repository's own TypeScript. It changes no published byte and
// is not part of the package; production consumers load the ESM file directly
// (Node 24) and the Node contract tests import it as ESM.
'use strict';

const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      fileName: sourcePath.replace(/\.mjs$/, '.js'),
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    return { code: outputText };
  },
};
