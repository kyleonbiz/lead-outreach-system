import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/supabase/env";
import { createServerSupabase } from "@/lib/supabase/server";
import { sameOrigin } from "@/lib/dms/server/respond";

export async function POST(request: Request) {
  // Stops a third-party page from signing the user out with a hidden form post.
  if (!sameOrigin(request)) return new Response("Cross-origin request blocked.", { status: 403 });
  if (getSupabaseEnv()) {
    const supabase = await createServerSupabase();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
