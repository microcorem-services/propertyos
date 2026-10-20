import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createPortfolioHandlers } from '@/lib/auth/portfolio-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: {
    params: Promise<{
      portfolioId: string;
      siteId: string;
      buildingId: string;
      unitId: string;
    }>;
  },
): Promise<Response> {
  const { portfolioId, siteId, buildingId, unitId } = await context.params;
  return createPortfolioHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).getUnit(request, portfolioId, siteId, buildingId, unitId);
}

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{
      portfolioId: string;
      siteId: string;
      buildingId: string;
      unitId: string;
    }>;
  },
): Promise<Response> {
  const { portfolioId, siteId, buildingId, unitId } = await context.params;
  return createPortfolioHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).updateUnit(request, portfolioId, siteId, buildingId, unitId);
}
