import { connection } from "next/server";
import { describeDhanError, getProfile } from "@/lib/dhan";

export async function GET() {
  await connection();

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
