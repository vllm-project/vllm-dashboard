import { after } from "next/server";
import { triageEnabled } from "@/lib/triage-auth";
import { applyTriageAction, maintainerForSlackUser, openAssignmentFor } from "@/lib/triage-data";
import {
  blocksAfterAction,
  ephemeral,
  parseSlackInteraction,
  verifySlackSignature,
} from "@/lib/triage-slack";

export const dynamic = "force-dynamic";

/**
 * Slack posts button clicks from triage DMs here (Interactivity Request URL).
 * Slack needs a 200 within 3 seconds, so the action runs inline (one short
 * transaction) and the message update is posted to Slack's response_url
 * after the response is sent.
 */
export async function POST(request: Request) {
  if (!triageEnabled()) return new Response("Not found", { status: 404 });
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return new Response("Slack interactivity is not configured.", { status: 503 });

  const rawBody = await request.text();
  if (
    !verifySlackSignature(
      secret,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      rawBody,
    )
  ) {
    return new Response("Invalid signature.", { status: 401 });
  }

  const click = parseSlackInteraction(rawBody);
  if (click.kind === "error") return new Response(click.error, { status: 400 });
  if (click.kind === "ignore") return new Response(null, { status: 200 });

  const reply = (body: Record<string, unknown>) =>
    after(async () => {
      try {
        await fetch(click.responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        console.error("Triage Slack follow-up failed:", error);
      }
    });

  const who = await maintainerForSlackUser(click.slackUserId);
  if (!who) {
    reply(ephemeral(
      "Your Slack account isn't linked to a triage maintainer. Add `slack_user_id` to your file in " +
        "triage/config/maintainers/ to act from Slack, or use https://ci.vllm.ai/triage/me.",
    ));
    return new Response(null, { status: 200 });
  }
  const { login, language } = who;
  // Only the person an item is assigned to can act on it from Slack.
  const assignmentId = await openAssignmentFor(click.itemKey, login);
  if (assignmentId === null) {
    reply(ephemeral(
      language === "vi"
        ? `${click.itemKey} hiện không được giao cho bạn, nên không có gì thay đổi.`
        : `${click.itemKey} isn't currently assigned to you, so nothing changed.`,
    ));
    return new Response(null, { status: 200 });
  }
  const result = await applyTriageAction(
    login,
    { itemKey: click.itemKey, action: click.action, assignmentId, target: click.target, note: null },
    "slack",
  );
  if (!result.ok) {
    reply(ephemeral(`Couldn't ${click.action.replace("_", " ")} ${click.itemKey}: ${result.error}`));
    return new Response(null, { status: 200 });
  }
  reply({
    replace_original: true,
    text: `${click.itemKey}: ${click.action.replace("_", " ")} by ${login}`,
    blocks: blocksAfterAction(
      click.blocks, click.itemKey, click.action, login, click.target, new Date(), language,
      "alsoApplied" in result ? result.alsoApplied : [],
    ),
  });
  return new Response(null, { status: 200 });
}
