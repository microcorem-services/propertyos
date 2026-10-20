import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createPortfolioHandlers } from '@/lib/auth/portfolio-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ buildingId: string }> },
): Promise<Response> {
  const { buildingId } = await context.params;
  return createPortfolioHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).updateBuilding(request, buildingId);
}
