import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { parseReminderDuration } from "../slack/later.ts";
import {
  addMessageTodo,
  addTodo,
  fetchTodos,
  parseTodoTarget,
  removeTodo,
  setTodoCompleted,
  setTodoReminder,
  type TodoRef,
  type TodoState,
} from "../slack/todos.ts";
import { parseSlackMessageUrl } from "../slack/url.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import type { SlackApiClient } from "../slack/client.ts";
import { getString } from "../lib/object-type-guards.ts";

const WHEN_HELP =
  "30m, 1h, 3h, 2d, tomorrow, monday, or Unix timestamp; named days use this process's local timezone at 9:00";

function parseState(value: string): TodoState {
  const v = value.toLowerCase().trim();
  if (v === "open" || v === "completed" || v === "all") {
    return v;
  }
  throw new Error(`Invalid state: "${value}". Use open, completed, or all.`);
}

export function registerTodoCommand(input: { program: Command; ctx: CliContext }): void {
  const { ctx } = input;

  async function run<T>(
    workspace: string | undefined,
    work: (client: SlackApiClient, workspaceUrl: string | undefined) => Promise<T>,
  ): Promise<T> {
    const workspaceUrl = ctx.effectiveWorkspaceUrl(workspace);
    return ctx.withAutoRefresh({
      workspaceUrl,
      work: async () => {
        const { client, workspace_url } = await ctx.getClientForWorkspace(workspaceUrl);
        return work(client, workspace_url);
      },
    });
  }

  function report(action: () => Promise<unknown>): Promise<void> {
    return action().then(
      (out) => console.log(JSON.stringify(pruneEmpty(out), null, 2)),
      (err: unknown) => {
        console.error(ctx.errorMessage(err));
        process.exitCode = 1;
      },
    );
  }

  function workspaceOf(ref: TodoRef, workspace?: string): string | undefined {
    return ref.itemType === "message" ? ref.workspaceUrl : workspace;
  }

  const todoCmd = input.program
    .command("todo")
    .description("Manage your Slack To-dos (personal to-do list)");

  todoCmd
    .command("list", { isDefault: true })
    .description("List to-dos")
    .option("--workspace <url>", "Workspace URL (defaults to your configured workspace)")
    .option("--state <state>", "open (default), completed, or all", "open")
    .option("--limit <n>", "Max to-dos to show", "20")
    .option("--max-body-chars <n>", "Max message characters per to-do (-1 for unlimited)", "4000")
    .action((options: { workspace?: string; state: string; limit: string; maxBodyChars: string }) =>
      report(async () => {
        const state = parseState(options.state);
        return run(options.workspace, async (client, workspaceUrl) => {
          const url = workspaceUrl ?? getString((await client.api("auth.test", {})).url);
          if (!url) {
            throw new Error("Could not determine the workspace URL; pass --workspace.");
          }
          return fetchTodos(client, {
            workspaceUrl: url,
            state,
            limit: Number.parseInt(options.limit, 10),
            maxBodyChars: Number.parseInt(options.maxBodyChars, 10),
          });
        });
      }),
    );

  todoCmd
    .command("add")
    .description("Add a to-do; a Slack message URL adds that message instead of text")
    .argument("<text>", "To-do text, or a Slack message URL")
    .option("--remind <when>", `Set a reminder: ${WHEN_HELP}`)
    .option("--workspace <url>", "Workspace URL (for text to-dos)")
    .action((text: string, options: { remind?: string; workspace?: string }) =>
      report(async () => {
        const remindAt = options.remind ? parseReminderDuration(options.remind) : undefined;
        let message;
        try {
          message = parseSlackMessageUrl(text.trim());
        } catch {
          message = undefined;
        }
        if (message) {
          const ref = message;
          await run(ref.workspace_url, (client) =>
            addMessageTodo(client, { channelId: ref.channel_id, ts: ref.message_ts, remindAt }),
          );
          return { ok: true, id: text.trim(), remind_at: remindAt };
        }
        if (!text.trim()) {
          throw new Error("To-do text is empty");
        }
        const id = await run(options.workspace, (client) =>
          addTodo(client, { text: text.trim(), remindAt }),
        );
        return { ok: true, id, remind_at: remindAt };
      }),
    );

  for (const [name, completed, description] of [
    ["complete", true, "Mark a to-do as completed"],
    ["reopen", false, "Move a completed to-do back to open"],
  ] as const) {
    todoCmd
      .command(name)
      .description(description)
      .argument("<target>", "To-do id (Sa...) or Slack message URL")
      .option("--workspace <url>", "Workspace URL (for to-do ids)")
      .action((target: string, options: { workspace?: string }) =>
        report(async () => {
          const ref = parseTodoTarget(target);
          await run(workspaceOf(ref, options.workspace), (client) =>
            setTodoCompleted(client, { ref, completed }),
          );
          return { ok: true };
        }),
      );
  }

  todoCmd
    .command("remind")
    .description("Set a reminder for a to-do")
    .argument("<target>", "To-do id (Sa...) or Slack message URL")
    .requiredOption("--in <when>", WHEN_HELP)
    .option("--workspace <url>", "Workspace URL (for to-do ids)")
    .action((target: string, options: { in: string; workspace?: string }) =>
      report(async () => {
        const ref = parseTodoTarget(target);
        const remindAt = parseReminderDuration(options.in);
        await run(workspaceOf(ref, options.workspace), (client) =>
          setTodoReminder(client, { ref, remindAt }),
        );
        return { ok: true, remind_at: remindAt };
      }),
    );

  todoCmd
    .command("remove")
    .description("Delete a to-do")
    .argument("<target>", "To-do id (Sa...) or Slack message URL")
    .option("--workspace <url>", "Workspace URL (for to-do ids)")
    .action((target: string, options: { workspace?: string }) =>
      report(async () => {
        const ref = parseTodoTarget(target);
        await run(workspaceOf(ref, options.workspace), (client) => removeTodo(client, ref));
        return { ok: true };
      }),
    );
}
