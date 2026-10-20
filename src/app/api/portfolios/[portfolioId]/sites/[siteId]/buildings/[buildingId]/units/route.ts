import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createPortfolioHandlers } from '@/lib/auth/portfolio-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: {
    params: Promise<{ portfolioId: string; siteId: string; buildingId: string }>;
  },
): Promise<Response> {
  const { portfolioId, siteId, buildingId } = await context.params;
  return createPortfolioHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).getUnits(request, portfolioId, siteId, buildingId);
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{ portfolioId: string; siteId: string; buildingId: string }>;
  },
): Promise<Response> {
  const { portfolioId, siteId, buildingId } = await context.params;
  return createPortfolioHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).createUnit(request, portfolioId, siteId, buildingId);
}
