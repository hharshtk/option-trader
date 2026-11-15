import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { describeDhanError, getProfile } from "@/lib/dhan";

export async function GET() {
  await connection();
  if (!(await isSignedIn())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const profile = await getProfile();
    return Response.json({
      connected: true,
      clientId: profile.dhanClientId,
      tokenValidity: profile.tokenValidity,
      activeSegment: profile.activeSegment,
      dataPlan: profile.dataPlan,
    });
  } catch (error) {
    return Response.json(
      { connected: false, error: describeDhanError(error) },
      { status: 503 },
    );
  }
}
