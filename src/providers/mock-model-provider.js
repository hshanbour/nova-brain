export function createMockModelProvider() {
  return Object.freeze({
    name: "mock",
    async generate({ message }) {
      return {
        type: "final",
        message: `Nova is ready. I received: ${message}`
      };
    }
  });
}
