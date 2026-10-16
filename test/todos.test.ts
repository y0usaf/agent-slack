import { describe, expect, test } from "bun:test";
import {
  addMessageTodo,
  addTodo,
  fetchTodos,
  parseTodoTarget,
  removeTodo,
  setTodoCompleted,
  setTodoReminder,
} from "../src/slack/todos.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

function createClient(responses: Record<string, Record<string, unknown>>) {
  const calls: { method: string; params: Record<string, unknown>; multipart?: boolean }[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return responses[method] ?? { ok: true };
    },
    apiMultipart: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params, multipart: true });
      return responses[method] ?? { ok: true };
    },
  } as unknown as SlackApiClient;
  return { client, calls };
}

const WORKSPACE = "https://acme.slack.com";

function reminder(id: string, extra: Record<string, unknown> = {}) {
  return {
    item_id: id,
    item_type: "reminder",
    date_created: 100,
    date_due: 100,
    date_completed: 0,
    todo_state: "to_do",
    description: [
      {
        type: "rich_text",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: `do ${id}` }] }],
      },
    ],
    ...extra,
  };
}

describe("parseTodoTarget", () => {
  test("accepts to-do ids and message URLs", () => {
    expect(parseTodoTarget("Sa0CANNV3FMW")).toEqual({
      itemType: "reminder",
      itemId: "Sa0CANNV3FMW",
    });
    expect(parseTodoTarget(`${WORKSPACE}/archives/C123/p1700000000000100`)).toEqual({
      itemType: "message",
      channelId: "C123",
      ts: "1700000000.000100",
      workspaceUrl: WORKSPACE,
    });
  });

  test("rejects anything else", () => {
    expect(() => parseTodoTarget("general")).toThrow("Invalid to-do target");
  });
});

describe("fetchTodos", () => {
  test("open to-dos use the todo filter and render text and reminders", async () => {
    const { client, calls } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [reminder("Sa1"), reminder("Sa2", { date_due: 500 })],
      },
    });

    const result = await fetchTodos(client, { workspaceUrl: WORKSPACE });

    expect(calls[0]?.params.filter).toBe("todo");
    expect(result.items).toEqual([
      { id: "Sa1", item_type: "reminder", state: "open", date_created: 100, text: "do Sa1" },
      {
        id: "Sa2",
        item_type: "reminder",
        state: "open",
        date_created: 100,
        remind_at: 500,
        text: "do Sa2",
      },
    ]);
  });

  test("completed to-dos come from todo_with_completed", async () => {
    const { client, calls } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          reminder("Sa1"),
          reminder("Sa2", { todo_state: "completed", date_completed: 200 }),
        ],
      },
    });

    const result = await fetchTodos(client, { workspaceUrl: WORKSPACE, state: "completed" });

    expect(calls[0]?.params.filter).toBe("todo_with_completed");
    expect(result.items.map((i) => [i.id, i.state, i.date_completed])).toEqual([
      ["Sa2", "completed", 200],
    ]);
  });

  test("message to-dos are identified by their URL", async () => {
    const { client } = createClient({
      "saved.list": {
        ok: true,
        saved_items: [
          {
            item_id: "C123",
            item_type: "message",
            ts: "1700000000.000100",
            date_created: 100,
            date_due: 0,
            todo_state: "to_do",
          },
        ],
      },
      "conversations.info": { ok: true, channel: { name: "general" } },
      "conversations.history": {
        ok: true,
        messages: [{ ts: "1700000000.000100", user: "U1", text: "ship it" }],
      },
    });

    const result = await fetchTodos(client, { workspaceUrl: WORKSPACE });

    expect(result.items[0]).toMatchObject({
      id: `${WORKSPACE}/archives/C123/p1700000000000100`,
      channel_name: "general",
      message: { content: "ship it" },
    });
  });

  test("pages until the limit is filled", async () => {
    let page = 0;
    const calls: Record<string, unknown>[] = [];
    const client = {
      api: async (_method: string, params: Record<string, unknown> = {}) => {
        calls.push(params);
        page += 1;
        return {
          ok: true,
          saved_items: [reminder(`Sa${page}`)],
          response_metadata: { next_cursor: page < 3 ? `c${page}` : "" },
        };
      },
    } as unknown as SlackApiClient;

    const result = await fetchTodos(client, { workspaceUrl: WORKSPACE, limit: 2 });

    expect(result.items.map((i) => i.id)).toEqual(["Sa1", "Sa2"]);
    expect(calls.map((c) => c.cursor)).toEqual([undefined, "c1"]);
    expect(result.next_cursor).toBe("c2");
  });
});

describe("writes", () => {
  test("addTodo creates a rich-text to-do and sets its reminder separately", async () => {
    const { client, calls } = createClient({
      "saved.add": { ok: true, item: { item_id: "Sa9" } },
    });

    expect(await addTodo(client, { text: "call Bob", remindAt: 900 })).toBe("Sa9");
    expect(calls[0]).toMatchObject({
      method: "saved.add",
      params: { item_type: "reminder", todo_state: "to_do" },
    });
    expect(JSON.stringify(calls[0]?.params.description)).toContain("call Bob");
    expect(calls[1]).toEqual({
      method: "saved.update",
      params: { item_type: "reminder", item_id: "Sa9", date_due: 900 },
      multipart: true,
    });
  });

  test("addMessageTodo moves an already-saved message into to-dos", async () => {
    const { client, calls } = createClient({
      "saved.add": { ok: true, item: { todo_state: "saved" } },
    });

    await addMessageTodo(client, { channelId: "C1", ts: "1.2" });

    expect(calls.map((c) => [c.method, c.params.todo_state])).toEqual([
      ["saved.add", "to_do"],
      ["saved.update", "to_do"],
    ]);
  });

  test("addMessageTodo stops after saved.add when the message is now a to-do", async () => {
    const { client, calls } = createClient({
      "saved.add": { ok: true, item: { todo_state: "to_do" } },
    });

    await addMessageTodo(client, { channelId: "C1", ts: "1.2" });

    expect(calls).toHaveLength(1);
  });

  test("complete, reopen, remind and remove target the saved item", async () => {
    const { client, calls } = createClient({});
    const ref = { itemType: "reminder", itemId: "Sa1" } as const;

    await setTodoCompleted(client, { ref, completed: true });
    await setTodoCompleted(client, { ref, completed: false });
    await setTodoReminder(client, { ref, remindAt: 42 });
    await removeTodo(client, ref);

    expect(calls.map((c) => [c.method, c.params])).toEqual([
      [
        "saved.update",
        { item_type: "reminder", item_id: "Sa1", mark: "completed", todo_state: "completed" },
      ],
      [
        "saved.update",
        { item_type: "reminder", item_id: "Sa1", mark: "uncompleted", todo_state: "to_do" },
      ],
      ["saved.update", { item_type: "reminder", item_id: "Sa1", date_due: 42 }],
      ["saved.delete", { item_type: "reminder", item_id: "Sa1" }],
    ]);
  });
});
