import { dispatch } from "@/server/dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };
const handle = async (req: Request, ctx: Ctx) => dispatch(req, (await ctx.params).path);

export const GET = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
