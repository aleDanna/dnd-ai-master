// Mock server-only at the module level to prevent it from throwing during import
import Module from 'module';

const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
  if (id === 'server-only') {
    return {};
  }
  return originalRequire.apply(this, [id]);
};
