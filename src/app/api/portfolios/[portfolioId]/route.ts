import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createPortfolioHandlers } from '@/lib/auth/portfolio-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const { portfolioId } = await context.params;
  return createPortfolioHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).getPortfolio(request, portfolioId);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const { portfolioId } = await context.params;
  return createPortfolioHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).updatePortfolio(request, portfolioId);
}
