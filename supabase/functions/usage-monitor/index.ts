// Project capacity endpoint for Embedded Learning Hub.
// Only signed-in Auth users on the explicit UUID allowlist can read project-wide usage.
// @supabase/server keeps the secret key and admin client on the server.
import { withSupabase } from "npm:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// withSupabase verifies the caller's user JWT and provides both the user-scoped
// client and the server-only admin client. Keep the preflight outside the wrapper
// because browsers send OPTIONS without the user's Authorization header.
const handleAuthenticatedUsage = withSupabase(
  { auth: "user" },
  async (_req, ctx) => {
    const userId = String(ctx.userClaims?.id || "");
    if (!userId) return jsonResponse({ error: "Authentication required." }, 401);

    const allowedIds = (Deno.env.get("USAGE_MONITOR_ALLOWED_USER_IDS") || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!allowedIds.length) {
      return jsonResponse({ error: "Usage monitor is not configured. Set USAGE_MONITOR_ALLOWED_USER_IDS to the permitted Auth user UUID." }, 503);
    }
    if (!allowedIds.includes(userId)) {
      return jsonResponse({ error: "This account is not allowed to view project-wide usage." }, 403);
    }

    const { data, error } = await ctx.supabaseAdmin.rpc("get_project_usage");
    if (error) {
      console.error("get_project_usage RPC failed", error);
      return jsonResponse({ error: "Could not read project usage. Confirm the SQL function is installed and executable by the server-side admin role." }, 500);
    }
    return jsonResponse(data || {}, 200);
  },
);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  return await handleAuthenticatedUsage(req);
});
