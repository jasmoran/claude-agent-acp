import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

const { getSessionMessagesSpy } = vi.hoisted(() => ({
  getSessionMessagesSpy: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    getSessionMessages: getSessionMessagesSpy,
  };
});

const SESSION_ID = "test-session";

describe("replaySessionHistory", () => {
  let agent: ClaudeAcpAgentType;
  let sessionUpdates: SessionNotification[];

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        sessionUpdates.push(notification);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  async function replay(): Promise<void> {
    await (
      agent as unknown as { replaySessionHistory: (id: string) => Promise<void> }
    ).replaySessionHistory(SESSION_ID);
  }

  function userMessage(content: string) {
    return {
      type: "user",
      uuid: "u1",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: "user", content },
    };
  }

  function userTextChunks(): Array<{ text: string }> {
    return sessionUpdates
      .filter((n) => n.update.sessionUpdate === "user_message_chunk")
      .map((n) => {
        const content = (n.update as { content: { type: string; text: string } }).content;
        return { text: content.text };
      });
  }

  beforeEach(async () => {
    sessionUpdates = [];
    getSessionMessagesSpy.mockReset();

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    agent = new acpAgent.ClaudeAcpAgent(createMockClient());
  });

  it("skips user messages that are only slash-command metadata", async () => {
    getSessionMessagesSpy.mockResolvedValue([
      userMessage(
        "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>",
      ),
    ]);

    await replay();

    expect(userTextChunks()).toEqual([]);
  });

  it("skips local-command stdout/stderr only messages", async () => {
    getSessionMessagesSpy.mockResolvedValue([
      userMessage("<local-command-stdout>Set model to claude-opus-4-7[1m]</local-command-stdout>"),
      userMessage("<local-command-stderr>oops</local-command-stderr>"),
    ]);

    await replay();

    expect(userTextChunks()).toEqual([]);
  });

  it("strips metadata but keeps the user's real prompt when concatenated", async () => {
    getSessionMessagesSpy.mockResolvedValue([
      userMessage(
        "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>default</command-args><local-command-stdout>Set model to claude-opus-4-7[1m]</local-command-stdout>This is my real message here",
      ),
    ]);

    await replay();

    expect(userTextChunks()).toEqual([{ text: "This is my real message here" }]);
  });

  it("passes through user messages that have no command metadata", async () => {
    getSessionMessagesSpy.mockResolvedValue([userMessage("just a normal prompt")]);

    await replay();

    expect(userTextChunks()).toEqual([{ text: "just a normal prompt" }]);
  });
});
