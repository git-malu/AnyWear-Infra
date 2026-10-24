// Jest runs the CDK app as CommonJS. The stage contract at `lib/contracts.mjs` is
// plain ESM, so this test-only transformer compiles that one `.mjs` file to
// CommonJS with the repository's own TypeScript. It changes no source byte;
// production consumers load the ESM file directly (Node 24) and the Node contract
// tests import it as ESM.
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
