// src/invariant.ts
var PACKAGE_NAME = "@deepseek-ai/dsh-ide-context";
var name = "ide-context-invariant";
var inject = ["invariants"];
var install = () => {
};
var apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export {
  apply,
  inject,
  name
};
