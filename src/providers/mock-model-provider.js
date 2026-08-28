export function createMockModelProvider() {
  return Object.freeze({
    async generate({ message }) {
      return {
        provider: "mock",
        message: `Brian is ready. I received: ${message}`
      };
    }
  });
}
