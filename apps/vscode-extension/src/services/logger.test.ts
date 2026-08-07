import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendLine, disposeOutput } = vi.hoisted(() => ({
  appendLine: vi.fn(),
  disposeOutput: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine,
      dispose: disposeOutput,
    })),
  },
}));

import { SafeLogger } from "./logger";

describe("SafeLogger shutdown", () => {
  beforeEach(() => {
    appendLine.mockReset();
    disposeOutput.mockReset();
  });

  it("ignores late writes after the VS Code output channel is disposed", () => {
    const logger = new SafeLogger();
    logger.info("relay.listening", { port: 32_171 });
    expect(appendLine).toHaveBeenCalledOnce();

    logger.dispose();
    logger.info("relay.socket-close", { code: 1001 });
    logger.error("relay.socket-error", "RELAY_SOCKET_ERROR");
    logger.dispose();

    expect(appendLine).toHaveBeenCalledOnce();
    expect(disposeOutput).toHaveBeenCalledOnce();
  });

  it("establishes the write fence when VS Code already closed the channel", () => {
    disposeOutput.mockImplementationOnce(() => {
      throw new Error("Channel has been closed");
    });
    const logger = new SafeLogger();

    expect(() => logger.dispose()).not.toThrow();
    logger.info("relay.socket-close", { code: 1001 });

    expect(appendLine).not.toHaveBeenCalled();
  });
});
