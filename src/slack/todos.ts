import type { SlackApiClient } from "./client.ts";
import { fetchSavedMessage, type LaterItem } from "./later.ts";
import { extractMrkdwnFromRichTextBlock } from "./render-rich-text.ts";
import { buildSlackMessageUrl, parseSlackMessageUrl } from "./url.ts";
import { asArray, getNumber, getString, isRecord } from "../lib/object-type-guards.ts";

export type TodoState = "open" | "completed" | "all";

export type TodoRef =
  | { itemType: "reminder"; itemId: string }
  | { itemType: "message"; channelId: string; ts: string; workspaceUrl: string };

export type TodoItem = {
  id: string;
  item_type: string;
  state: "open" | "completed";
  text?: string;
  channel_id?: string;
  channel_name?: string;
  ts?: string;
  message?: LaterItem["message"];
  date_created: number;
  remind_at?: number;
  date_completed?: number;
};

const TODO_ID_PATTERN = /^Sa[A-Z0-9]+$/;

/**
 * A to-do target is either a standalone to-do id (`Sa...`, from `todo list`)
 * or the Slack URL of a message that is on the to-do list.
 */
export function parseTodoTarget(input: string): TodoRef {
  const trimmed = input.trim();
  if (TODO_ID_PATTERN.test(trimmed)) {
    return { itemType: "reminder", itemId: trimmed };
  }
  let ref;
  try {
    ref = parseSlackMessageUrl(trimmed);
  } catch {
    throw new Error(
      `Invalid to-do target: "${input}". Use a to-do id (Sa...) from "todo list" or a Slack message URL.`,
    );
  }
  return {
    itemType: "message",
    channelId: ref.channel_id,
    ts: ref.message_ts,
    workspaceUrl: ref.workspace_url,
  };
}

function refParams(ref: TodoRef): Record<string, unknown> {
  return ref.itemType === "reminder"
    ? { item_type: "reminder", item_id: ref.itemId }
    : { item_type: "message", item_id: ref.channelId, ts: ref.ts };
}

export async function fetchTodos(
  client: SlackApiClient,
  options: { workspaceUrl: string; state?: TodoState; limit?: number; maxBodyChars?: number },
): Promise<{ items: TodoItem[]; next_cursor?: string }> {
  const state = options.state ?? "open";
  const limit = options.limit ?? 20;
  const maxBodyChars = options.maxBodyChars ?? 4000;
  const wanted = (item: Record<string, unknown>) =>
    state === "all" || (getString(item.todo_state) === "completed") === (state === "completed");

  const raw: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const resp = await client.api("saved.list", {
      limit: 50,
      cursor,
      filter: state === "open" ? "todo" : "todo_with_completed",
    });
    raw.push(...asArray(resp.saved_items).filter(isRecord).filter(wanted));
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    cursor = (meta && getString(meta.next_cursor)) || undefined;
  } while (raw.length < limit && cursor);

  const items = await Promise.all(
    raw
      .slice(0, limit)
      .map((item) =>
        toTodoItem(client, { item, workspaceUrl: options.workspaceUrl, maxBodyChars }),
      ),
  );
  return { items, next_cursor: cursor };
}

async function toTodoItem(
  client: SlackApiClient,
  input: { item: Record<string, unknown>; workspaceUrl: string; maxBodyChars: number },
): Promise<TodoItem> {
  const { item, workspaceUrl, maxBodyChars } = input;
  const itemType = getString(item.item_type) ?? "";
  const itemId = getString(item.item_id) ?? "";
  const created = getNumber(item.date_created) ?? 0;
  const due = getNumber(item.date_due) ?? 0;
  const completed = getNumber(item.date_completed) ?? 0;
  const base = {
    item_type: itemType,
    state: getString(item.todo_state) === "completed" ? "completed" : "open",
    date_created: created,
    remind_at: due > 1 && due !== created ? due : undefined,
    date_completed: completed > 0 ? completed : undefined,
  } as const;

  const ts = getString(item.ts);
  if (itemType === "message" && ts) {
    const { channelName, message } = await fetchSavedMessage(client, {
      channelId: itemId,
      ts,
      maxBodyChars,
    });
    return {
      id: buildSlackMessageUrl({ workspace_url: workspaceUrl, channel_id: itemId, message_ts: ts }),
      ...base,
      channel_id: itemId,
      channel_name: channelName,
      ts,
      message,
    };
  }

  const text = asArray(item.description)
    .map((block) => extractMrkdwnFromRichTextBlock(block))
    .filter(Boolean)
    .join("\n\n");
  return { id: itemId, ...base, text: text || undefined };
}

export async function addTodo(
  client: SlackApiClient,
  input: { text: string; remindAt?: number },
): Promise<string> {
  const resp = await client.api("saved.add", {
    item_type: "reminder",
    description: [
      {
        type: "rich_text",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: input.text }] }],
      },
    ],
    todo_state: "to_do",
  });
  const itemId = isRecord(resp.item) ? getString(resp.item.item_id) : undefined;
  if (!itemId) {
    throw new Error("saved.add returned no to-do id");
  }
  if (input.remindAt !== undefined) {
    await setTodoReminder(client, {
      ref: { itemType: "reminder", itemId },
      remindAt: input.remindAt,
    });
  }
  return itemId;
}

/**
 * Put a message on the to-do list. saved.add leaves an already-saved message
 * in Saved, so a message that did not land as a to-do is moved explicitly.
 */
export async function addMessageTodo(
  client: SlackApiClient,
  input: { channelId: string; ts: string; remindAt?: number },
): Promise<void> {
  const params = { item_type: "message", item_id: input.channelId, ts: input.ts };
  const resp = await client.api("saved.add", { ...params, todo_state: "to_do" });
  const item = isRecord(resp.item) ? resp.item : {};
  if (getString(item.todo_state) !== "to_do" || input.remindAt !== undefined) {
    await client.apiMultipart("saved.update", {
      ...params,
      todo_state: "to_do",
      date_due: input.remindAt,
    });
  }
}

export async function setTodoCompleted(
  client: SlackApiClient,
  input: { ref: TodoRef; completed: boolean },
): Promise<void> {
  await client.apiMultipart("saved.update", {
    ...refParams(input.ref),
    mark: input.completed ? "completed" : "uncompleted",
    todo_state: input.completed ? "completed" : "to_do",
  });
}

/**
 * Slack stores a to-do's reminder in date_due; a date_due equal to
 * date_created is Slack's encoding for "no reminder".
 */
export async function setTodoReminder(
  client: SlackApiClient,
  input: { ref: TodoRef; remindAt: number },
): Promise<void> {
  await client.apiMultipart("saved.update", { ...refParams(input.ref), date_due: input.remindAt });
}

export async function removeTodo(client: SlackApiClient, ref: TodoRef): Promise<void> {
  await client.api("saved.delete", refParams(ref));
}
